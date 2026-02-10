"""
病棟勤務表 シフト自動生成エンジン

シフト種別:
  日 = 日勤
  夜 = 夜勤
  明 = 明け（夜勤翌日）
  公 = 公休
  委 = 委員会（固定）
  希 = 希望休（固定）

生成順序:
  1. 夜勤リーダー配置
  2. 夜勤ペア配置
  3. 日勤リーダー配置
  4. 日勤メンバー配置
  5. 残り空セルを公休で埋める

夜勤ルール: 夜勤 → 明け → 公休（3日セット）
"""

import random
from typing import List, Dict, Tuple, Optional


class ShiftGenerator:
    """勤務表自動生成クラス"""

    # シフト種別定数
    DAY = "日"
    NIGHT = "夜"
    MORNING_AFTER = "明"
    HOLIDAY = "公"
    COMMITTEE = "委"
    REQUESTED_OFF = "希"

    # 休日扱いのシフト種別
    OFF_TYPES = {"公", "希", "休", "有"}

    def __init__(
        self,
        staff_ids: List[str],
        num_days: int,
        schedule: List[List[str]],
        settings: Dict,
    ):
        self.staff_ids = staff_ids
        self.num_staff = len(staff_ids)
        self.num_days = num_days

        # スケジュールのディープコピー
        self.schedule = [row[:] for row in schedule]

        # 固定セル（元データで既に値が入っているセル）
        self.fixed = [[cell.strip() != "" for cell in row] for row in schedule]

        # 設定値
        self.day_leader_count = settings["day_leader_count"]
        self.night_leader_count = settings["night_leader_count"]
        self.night_eligible_count = settings.get(
            "night_eligible_count", self.num_staff
        )
        self.required_per_day = settings["required_staff_per_day"]
        self.max_nights = settings["max_night_shifts"]
        self.days_off = settings["days_off"]

        # 夜勤回数カウンター
        self.night_counts = [0] * self.num_staff

        # 警告メッセージ
        self.warnings: List[str] = []

    def generate(self) -> Tuple[List[List[str]], List[str]]:
        """メインの生成処理"""
        self._check_feasibility()
        self._preprocess()
        self._place_night_leaders()
        self._place_night_pairs()
        self._assign_day_shifts()
        self._fill_remaining()
        self._validate()
        return self.schedule, self.warnings

    # =========================================================
    # 事前チェック
    # =========================================================

    def _check_feasibility(self):
        """設定の実現可能性チェック"""
        # 夜勤リーダーの総キャパ
        leader_capacity = self.night_leader_count * self.max_nights
        if leader_capacity < self.num_days:
            self.warnings.append(
                f"夜勤リーダーが不足する可能性: "
                f"{self.night_leader_count}人 x {self.max_nights}回 = "
                f"{leader_capacity}回 < {self.num_days}日"
            )

        # 夜勤ペアの総キャパ（リーダー以外の夜勤可能者）
        pair_pool = self.night_eligible_count - self.night_leader_count
        if pair_pool > 0:
            pair_capacity = pair_pool * self.max_nights
            # リーダーもペアになれるので、全体の夜勤可能キャパ
            total_night_capacity = self.night_eligible_count * self.max_nights
            if total_night_capacity < self.num_days * 2:
                self.warnings.append(
                    f"夜勤要員が不足する可能性: "
                    f"必要={self.num_days * 2}回, "
                    f"最大={total_night_capacity}回"
                )

    # =========================================================
    # 前処理
    # =========================================================

    def _preprocess(self):
        """前処理: 既存の夜勤に明け・公休を補完"""
        for s in range(self.num_staff):
            for d in range(self.num_days):
                if self.schedule[s][d] == self.NIGHT and self.fixed[s][d]:
                    self.night_counts[s] += 1
                    # 明けを補完
                    if d + 1 < self.num_days and self.schedule[s][d + 1] == "":
                        self.schedule[s][d + 1] = self.MORNING_AFTER
                    # 公休を補完
                    if d + 2 < self.num_days and self.schedule[s][d + 2] == "":
                        self.schedule[s][d + 2] = self.HOLIDAY

    # =========================================================
    # 夜勤判定
    # =========================================================

    def _can_assign_night(self, s: int, d: int) -> bool:
        """指定職員を指定日に夜勤割り当て可能か判定"""
        # 当日が空でなければ不可
        if self.schedule[s][d] != "":
            return False

        # 夜勤上限チェック
        if self.night_counts[s] >= self.max_nights:
            return False

        # 翌日（明け）チェック
        if d + 1 < self.num_days:
            cell = self.schedule[s][d + 1]
            if cell != "" and cell not in (
                self.MORNING_AFTER,
                self.HOLIDAY,
                self.REQUESTED_OFF,
                "休",
                "有",
            ):
                return False

        # 翌々日（公休）チェック
        if d + 2 < self.num_days:
            cell = self.schedule[s][d + 2]
            if cell != "" and cell not in (
                self.HOLIDAY,
                self.REQUESTED_OFF,
                "休",
                "有",
            ):
                return False

        # 直近の夜勤チェック（夜勤→明け→公休の3日間は夜勤不可）
        if d >= 1 and self.schedule[s][d - 1] in (self.NIGHT, self.MORNING_AFTER):
            return False
        if d >= 2 and self.schedule[s][d - 2] == self.NIGHT:
            return False

        return True

    def _assign_night_block(self, s: int, d: int):
        """夜勤ブロック（夜→明→公）を割り当て"""
        self.schedule[s][d] = self.NIGHT
        self.night_counts[s] += 1

        # 明けを設定（翌日が空の場合）
        if d + 1 < self.num_days:
            if not self.fixed[s][d + 1]:
                self.schedule[s][d + 1] = self.MORNING_AFTER
            # 固定セルが休日系なら上書きしない（互換性あり）

        # 公休を設定（翌々日が空の場合）
        if d + 2 < self.num_days:
            if not self.fixed[s][d + 2]:
                if self.schedule[s][d + 2] not in self.OFF_TYPES:
                    self.schedule[s][d + 2] = self.HOLIDAY

    def _select_candidate(self, candidates: List[int]) -> Optional[int]:
        """候補から1人選択（夜勤回数の少ない人を優先 + ランダム）"""
        if not candidates:
            return None

        random.shuffle(candidates)
        candidates.sort(key=lambda s: self.night_counts[s])

        # 最小夜勤回数 +1 以内の候補からランダム選択
        min_count = self.night_counts[candidates[0]]
        top = [s for s in candidates if self.night_counts[s] <= min_count + 1]

        return random.choice(top)

    # =========================================================
    # Phase 1: 夜勤リーダー配置
    # =========================================================

    def _place_night_leaders(self):
        """夜勤リーダーを各日に1人配置"""
        for d in range(self.num_days):
            # 既にリーダーが夜勤に入っているか確認
            has_leader = any(
                self.schedule[s][d] == self.NIGHT
                for s in range(self.night_leader_count)
            )
            if has_leader:
                continue

            # 候補を収集
            candidates = [
                s
                for s in range(self.night_leader_count)
                if self._can_assign_night(s, d)
            ]

            leader = self._select_candidate(candidates)
            if leader is None:
                self.warnings.append(f"{d + 1}日: 夜勤リーダーの候補が見つかりません")
                continue

            self._assign_night_block(leader, d)

    # =========================================================
    # Phase 2: 夜勤ペア配置
    # =========================================================

    def _place_night_pairs(self):
        """夜勤ペアを配置（リーダー不在の場合は2人とも配置）"""
        for d in range(self.num_days):
            # 2人揃うまでループ
            while True:
                night_staff = [
                    s
                    for s in range(self.num_staff)
                    if self.schedule[s][d] == self.NIGHT
                ]
                if len(night_staff) >= 2:
                    break

                # 候補を収集（夜勤可能者のうち、当日夜勤に入っていない人）
                candidates = [
                    s
                    for s in range(self.night_eligible_count)
                    if s not in night_staff and self._can_assign_night(s, d)
                ]

                pair = self._select_candidate(candidates)
                if pair is None:
                    if len(night_staff) == 0:
                        self.warnings.append(
                            f"{d + 1}日: 夜勤要員が見つかりません"
                        )
                    elif len(night_staff) == 1:
                        self.warnings.append(
                            f"{d + 1}日: 夜勤ペアの候補が見つかりません"
                        )
                    break

                self._assign_night_block(pair, d)

    # =========================================================
    # Phase 3 & 4: 日勤配置
    # =========================================================

    def _calculate_day_targets(self) -> List[int]:
        """各職員の目標日勤日数を計算"""
        targets = []
        for s in range(self.num_staff):
            night_count = self.night_counts[s]

            # 既に確定している休日数（公、希、休、有など）
            off_count = sum(
                1
                for d in range(self.num_days)
                if self.schedule[s][d] in self.OFF_TYPES
            )

            # 追加で必要な公休日数
            additional_off = max(0, self.days_off - off_count)

            # 空きセル数
            empty_count = sum(
                1 for d in range(self.num_days) if self.schedule[s][d] == ""
            )

            # 目標日勤日数 = 空きセル - 追加公休
            target_day = max(0, empty_count - additional_off)
            targets.append(target_day)

        return targets

    def _assign_day_shifts(self):
        """日勤リーダーおよび日勤メンバーを配置"""
        targets = self._calculate_day_targets()

        for d in range(self.num_days):
            # このに空いている職員
            available = [
                s for s in range(self.num_staff) if self.schedule[s][d] == ""
            ]

            # 既に日勤が入っている人数
            current_day = sum(
                1
                for s in range(self.num_staff)
                if self.schedule[s][d] == self.DAY
            )

            needed = self.required_per_day - current_day
            if needed <= 0:
                continue

            selected = []

            # --- 日勤リーダーの確保 ---
            has_day_leader = any(
                self.schedule[s][d] in (self.DAY, self.COMMITTEE)
                and s < self.day_leader_count
                for s in range(self.num_staff)
            )

            if not has_day_leader:
                leader_candidates = [
                    s for s in available if s < self.day_leader_count
                ]
                if leader_candidates:
                    # 目標日勤日数が多い人を優先
                    leader_candidates.sort(key=lambda s: targets[s], reverse=True)
                    leader = leader_candidates[0]
                    selected.append(leader)
                    available.remove(leader)
                    targets[leader] -= 1
                    needed -= 1

            # --- 残りの日勤メンバー ---
            if needed > 0 and available:
                random.shuffle(available)
                available.sort(key=lambda s: targets[s], reverse=True)

                for s in available[:needed]:
                    selected.append(s)
                    targets[s] -= 1

            # 日勤を割り当て
            for s in selected:
                self.schedule[s][d] = self.DAY

    # =========================================================
    # Phase 5: 残りを公休で埋める
    # =========================================================

    def _fill_remaining(self):
        """残りの空セルを公休で埋める"""
        for s in range(self.num_staff):
            for d in range(self.num_days):
                if self.schedule[s][d] == "":
                    self.schedule[s][d] = self.HOLIDAY

    # =========================================================
    # バリデーション
    # =========================================================

    def _validate(self):
        """生成結果の制約違反をチェック"""
        for d in range(self.num_days):
            # 夜勤人数チェック
            night_count = sum(
                1
                for s in range(self.num_staff)
                if self.schedule[s][d] == self.NIGHT
            )
            if night_count < 2:
                self.warnings.append(
                    f"{d + 1}日: 夜勤が{night_count}人（2人必要）"
                )

            # 日勤人数チェック
            day_count = sum(
                1
                for s in range(self.num_staff)
                if self.schedule[s][d] == self.DAY
            )
            if day_count < self.required_per_day:
                self.warnings.append(
                    f"{d + 1}日: 日勤が{day_count}人"
                    f"（{self.required_per_day}人必要）"
                )

            # 日勤リーダーチェック
            has_day_leader = any(
                self.schedule[s][d] in (self.DAY, self.COMMITTEE)
                and s < self.day_leader_count
                for s in range(self.num_staff)
            )
            if not has_day_leader:
                self.warnings.append(f"{d + 1}日: 日勤リーダーがいません")

        # 個人別チェック
        for s in range(self.num_staff):
            # 夜勤回数
            if self.night_counts[s] > self.max_nights:
                self.warnings.append(
                    f"職員{self.staff_ids[s]}: "
                    f"夜勤{self.night_counts[s]}回（上限{self.max_nights}回）"
                )

            # 公休日数
            off_days = sum(
                1
                for d in range(self.num_days)
                if self.schedule[s][d] in self.OFF_TYPES
            )
            if off_days < self.days_off - 1:  # 1日の誤差は許容
                self.warnings.append(
                    f"職員{self.staff_ids[s]}: "
                    f"休日{off_days}日（目標{self.days_off}日）"
                )


def generate_shift(
    staff_ids: List[str],
    num_days: int,
    schedule: List[List[str]],
    settings: Dict,
) -> Tuple[List[List[str]], List[str]]:
    """シフト生成のエントリーポイント"""
    generator = ShiftGenerator(staff_ids, num_days, schedule, settings)
    return generator.generate()
