/**
 * 病棟勤務表 自動作成システム - フロントエンドロジック
 */

// =========================================================
// 状態管理
// =========================================================

let uploadedData = null;   // { staff_ids, dates, schedule }
let originalSchedule = null; // アップロード時の元データ（再作成用）
let generatedSchedule = null; // 生成済みスケジュール

// =========================================================
// DOM要素
// =========================================================

const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const fileInfo = document.getElementById("fileInfo");
const fileName = document.getElementById("fileName");
const staffCount = document.getElementById("staffCount");
const generateBtn = document.getElementById("generateBtn");
const downloadBtn = document.getElementById("downloadBtn");
const loading = document.getElementById("loading");
const warningsPanel = document.getElementById("warningsPanel");
const warningsList = document.getElementById("warningsList");
const tablePanel = document.getElementById("tablePanel");
const scheduleTable = document.getElementById("scheduleTable");
const targetMonth = document.getElementById("targetMonth");

// =========================================================
// 年月ピッカー初期化
// =========================================================

// デフォルトで来月をセット
{
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const yyyy = next.getFullYear();
    const mm = String(next.getMonth() + 1).padStart(2, "0");
    targetMonth.value = `${yyyy}-${mm}`;
}

// 年月変更時にテーブルを再描画
targetMonth.addEventListener("change", () => {
    if (uploadedData) {
        const sched = generatedSchedule || uploadedData.schedule;
        const orig = generatedSchedule ? originalSchedule : null;
        renderTable(uploadedData.staff_ids, uploadedData.dates, sched, orig);
    }
});

// =========================================================
// プリセット機能
// =========================================================

const SETTING_KEYS = ["dayLeaderCount", "nightLeaderCount", "nightEligibleCount", "requiredPerDay", "maxNightShifts", "daysOff"];

const DEFAULT_PRESETS = {
    "デフォルト": {
        dayLeaderCount: 10,
        nightLeaderCount: 8,
        nightEligibleCount: 17,
        requiredPerDay: 5,
        maxNightShifts: 5,
        daysOff: 9,
    }
};

const presetSelect = document.getElementById("presetSelect");
const presetSaveBtn = document.getElementById("presetSaveBtn");
const presetDeleteBtn = document.getElementById("presetDeleteBtn");

function loadPresets() {
    const custom = JSON.parse(localStorage.getItem("shiftPresets") || "{}");
    const all = { ...DEFAULT_PRESETS, ...custom };
    const currentValue = presetSelect.value;

    presetSelect.innerHTML = "";
    for (const name of Object.keys(all)) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        presetSelect.appendChild(opt);
    }
    // (カスタム) option for manual edits
    const customOpt = document.createElement("option");
    customOpt.value = "__custom__";
    customOpt.textContent = "(カスタム)";
    customOpt.hidden = true;
    presetSelect.appendChild(customOpt);

    // Restore selection if it still exists, otherwise default
    if (all[currentValue]) {
        presetSelect.value = currentValue;
    } else {
        presetSelect.value = "デフォルト";
    }
}

function applyPreset(name) {
    const custom = JSON.parse(localStorage.getItem("shiftPresets") || "{}");
    const all = { ...DEFAULT_PRESETS, ...custom };
    const preset = all[name];
    if (!preset) return;

    for (const key of SETTING_KEYS) {
        const el = document.getElementById(key);
        if (el && preset[key] !== undefined) {
            el.value = preset[key];
        }
    }
}

function savePreset() {
    const name = prompt("プリセット名を入力してください:");
    if (!name || !name.trim()) return;
    const trimmed = name.trim();

    if (trimmed === "__custom__") {
        alert("この名前は使用できません。");
        return;
    }

    const values = {};
    for (const key of SETTING_KEYS) {
        values[key] = parseInt(document.getElementById(key).value) || 0;
    }

    const custom = JSON.parse(localStorage.getItem("shiftPresets") || "{}");
    custom[trimmed] = values;
    localStorage.setItem("shiftPresets", JSON.stringify(custom));

    loadPresets();
    presetSelect.value = trimmed;
}

function deletePreset() {
    const name = presetSelect.value;
    if (name === "__custom__") return;

    if (DEFAULT_PRESETS[name]) {
        alert("固定プリセットは削除できません。");
        return;
    }

    if (!confirm(`プリセット「${name}」を削除しますか？`)) return;

    const custom = JSON.parse(localStorage.getItem("shiftPresets") || "{}");
    delete custom[name];
    localStorage.setItem("shiftPresets", JSON.stringify(custom));

    loadPresets();
    presetSelect.value = "デフォルト";
    applyPreset("デフォルト");
}

presetSelect.addEventListener("change", () => {
    const name = presetSelect.value;
    if (name !== "__custom__") {
        applyPreset(name);
    }
});

presetSaveBtn.addEventListener("click", savePreset);
presetDeleteBtn.addEventListener("click", deletePreset);

// 設定値の手動変更を検知して「(カスタム)」に切り替え
for (const key of SETTING_KEYS) {
    document.getElementById(key).addEventListener("input", () => {
        presetSelect.value = "__custom__";
    });
}

// 初期化
loadPresets();

// =========================================================
// シフト種別 → CSSクラス対応表
// =========================================================

const SHIFT_CLASS_MAP = {
    "日": "shift-day",
    "夜": "shift-night",
    "明": "shift-morning-after",
    "公": "shift-holiday",
    "希": "shift-requested",
    "委": "shift-committee",
    "休": "shift-other",
    "有": "shift-other",
    "研": "shift-other",
};

// =========================================================
// ファイルアップロード
// =========================================================

// クリックでファイル選択
dropZone.addEventListener("click", () => fileInput.click());

// ドラッグ&ドロップ
dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        fileInput.files = files;
        handleFileUpload(files[0]);
    }
});

// ファイル選択
fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
        handleFileUpload(fileInput.files[0]);
    }
});

async function handleFileUpload(file) {
    if (!file.name.match(/\.xlsx?$/i)) {
        alert("xlsx形式のファイルを選択してください");
        return;
    }

    const formData = new FormData();
    formData.append("file", file);

    try {
        showLoading(true);
        const res = await fetch("/api/upload", {
            method: "POST",
            body: formData,
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "アップロードに失敗しました");
        }

        uploadedData = await res.json();
        originalSchedule = uploadedData.schedule.map(row => [...row]);
        generatedSchedule = null;

        // ファイル情報表示
        fileName.textContent = file.name;
        staffCount.textContent = `（${uploadedData.staff_ids.length}名 × ${uploadedData.dates.length}日）`;
        fileInfo.classList.remove("hidden");

        // ボタン有効化・ラベルリセット
        generateBtn.disabled = false;
        generateBtn.textContent = "シフト作成";
        downloadBtn.disabled = true;

        // テーブル表示（元データ）
        renderTable(uploadedData.staff_ids, uploadedData.dates, uploadedData.schedule);
        hideWarnings();

    } catch (err) {
        alert(err.message);
    } finally {
        showLoading(false);
    }
}

// =========================================================
// シフト生成
// =========================================================

generateBtn.addEventListener("click", () => generateShift());

async function generateShift() {
    if (!uploadedData) return;

    const settings = getSettings();

    try {
        showLoading(true);

        const res = await fetch("/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                staff_ids: uploadedData.staff_ids,
                dates: uploadedData.dates,
                schedule: originalSchedule.map(row => [...row]),
                settings: settings,
            }),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "シフト生成に失敗しました");
        }

        const result = await res.json();
        generatedSchedule = result.schedule;

        // ボタン有効化・ラベルを「再作成」に変更
        generateBtn.textContent = "再作成";
        downloadBtn.disabled = false;

        // テーブル表示
        renderTable(
            uploadedData.staff_ids,
            uploadedData.dates,
            generatedSchedule,
            originalSchedule
        );

        // 警告表示
        if (result.warnings && result.warnings.length > 0) {
            showWarnings(result.warnings);
        } else {
            hideWarnings();
        }

    } catch (err) {
        alert(err.message);
    } finally {
        showLoading(false);
    }
}

// =========================================================
// ダウンロード
// =========================================================

downloadBtn.addEventListener("click", async () => {
    if (!generatedSchedule) return;

    try {
        showLoading(true);

        const res = await fetch("/api/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                staff_ids: uploadedData.staff_ids,
                dates: uploadedData.dates,
                schedule: generatedSchedule,
            }),
        });

        if (!res.ok) {
            throw new Error("ダウンロードに失敗しました");
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "勤務表.xlsx";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    } catch (err) {
        alert(err.message);
    } finally {
        showLoading(false);
    }
});

// =========================================================
// 設定値の取得
// =========================================================

function getSettings() {
    return {
        day_leader_count: parseInt(document.getElementById("dayLeaderCount").value) || 10,
        night_leader_count: parseInt(document.getElementById("nightLeaderCount").value) || 8,
        night_eligible_count: parseInt(document.getElementById("nightEligibleCount").value) || 17,
        required_staff_per_day: parseInt(document.getElementById("requiredPerDay").value) || 5,
        max_night_shifts: parseInt(document.getElementById("maxNightShifts").value) || 5,
        days_off: parseInt(document.getElementById("daysOff").value) || 9,
    };
}

// =========================================================
// テーブル描画
// =========================================================

function renderTable(staffIds, dates, schedule, original = null) {
    const settings = getSettings();
    let html = "";

    // ヘッダー行
    html += "<thead><tr>";
    html += "<th>職員番号</th>";
    for (const date of dates) {
        const dayClass = getDayClass(date);
        html += `<th class="${dayClass}">${date}</th>`;
    }
    // 統計列
    html += '<th class="stats-col">夜</th>';
    html += '<th class="stats-col">日</th>';
    html += '<th class="stats-col">公</th>';
    html += "</tr></thead>";

    // データ行
    html += "<tbody>";
    for (let i = 0; i < staffIds.length; i++) {
        // 行のクラス（リーダー表示）
        let rowClass = "";
        if (i < settings.night_leader_count) {
            rowClass = "leader-row";
        } else if (i < settings.night_eligible_count) {
            rowClass = "night-eligible-row";
        }

        html += `<tr class="${rowClass}">`;
        html += `<td>${staffIds[i]}</td>`;

        // 統計カウンター
        let nightCount = 0;
        let dayCount = 0;
        let offCount = 0;

        for (let j = 0; j < dates.length; j++) {
            const shift = schedule[i] && schedule[i][j] ? schedule[i][j] : "";
            const isFixed = original ? (original[i][j] && original[i][j].trim() !== "") : false;
            const cellClass = getCellClass(shift);
            const fixedClass = isFixed ? " shift-fixed" : "";

            html += `<td class="${cellClass}${fixedClass}">${shift}</td>`;

            // 統計
            if (shift === "夜") nightCount++;
            if (shift === "日") dayCount++;
            if (["公", "希", "休", "有"].includes(shift)) offCount++;
        }

        // 統計列（バッジ表示）
        const nightBadge = getStatBadge(nightCount, settings.max_night_shifts, "night");
        const offBadge = getStatBadge(offCount, settings.days_off, "off");

        html += `<td class="stats-col">${nightBadge}</td>`;
        html += `<td class="stats-col">${dayCount}</td>`;
        html += `<td class="stats-col">${offBadge}</td>`;
        html += "</tr>";
    }

    // 日別統計行
    html += '<tr class="font-semibold bg-gray-50">';
    html += "<td>日勤計</td>";
    for (let j = 0; j < dates.length; j++) {
        let dayTotal = 0;
        for (let i = 0; i < staffIds.length; i++) {
            if (schedule[i] && schedule[i][j] === "日") dayTotal++;
        }
        const shortage = dayTotal < settings.required_staff_per_day;
        html += `<td class="${shortage ? 'text-red-600 font-bold' : 'text-gray-600'}">${dayTotal}</td>`;
    }
    html += '<td class="stats-col"></td><td class="stats-col"></td><td class="stats-col"></td>';
    html += "</tr>";

    html += '<tr class="font-semibold bg-gray-50">';
    html += "<td>夜勤計</td>";
    for (let j = 0; j < dates.length; j++) {
        let nightTotal = 0;
        for (let i = 0; i < staffIds.length; i++) {
            if (schedule[i] && schedule[i][j] === "夜") nightTotal++;
        }
        const shortage = nightTotal < 2;
        html += `<td class="${shortage ? 'text-red-600 font-bold' : 'text-gray-600'}">${nightTotal}</td>`;
    }
    html += '<td class="stats-col"></td><td class="stats-col"></td><td class="stats-col"></td>';
    html += "</tr>";

    html += "</tbody>";

    scheduleTable.innerHTML = html;
    showPanel(tablePanel);
}

function getCellClass(shift) {
    return SHIFT_CLASS_MAP[shift] || "";
}

function getDayClass(dateStr) {
    const monthVal = targetMonth.value; // "YYYY-MM"
    if (!monthVal) return "";

    const [yearStr, monthStr] = monthVal.split("-");
    const year = parseInt(yearStr);
    const month = parseInt(monthStr); // 1-based

    // dateStr is like "1", "2", ... "31"
    const day = parseInt(dateStr);
    if (isNaN(day)) return "";

    const d = new Date(year, month - 1, day);
    const dow = d.getDay(); // 0=Sun, 6=Sat

    if (dow === 0) return "sunday";
    if (dow === 6) return "saturday";
    return "";
}

// =========================================================
// 統計バッジ
// =========================================================

function getStatBadge(value, target, type) {
    if (type === "night") {
        // 夜勤: 上限に達したら赤バッジ
        if (value >= target && target > 0) {
            return `<span class="stat-badge stat-badge-danger">${value}</span>`;
        }
        if (value >= target - 1 && target > 0) {
            return `<span class="stat-badge stat-badge-warning">${value}</span>`;
        }
        return `<span class="stat-badge stat-badge-ok">${value}</span>`;
    }
    if (type === "off") {
        // 公休: 目標と2以上乖離でハイライト
        const diff = Math.abs(value - target);
        if (diff >= 2) {
            return `<span class="stat-badge stat-badge-danger">${value}</span>`;
        }
        if (diff >= 1) {
            return `<span class="stat-badge stat-badge-warning">${value}</span>`;
        }
        return `<span class="stat-badge stat-badge-ok">${value}</span>`;
    }
    return `${value}`;
}

// =========================================================
// UI ユーティリティ（スムーズアニメーション）
// =========================================================

function showPanel(el) {
    el.classList.remove("panel-hidden");
}

function hidePanel(el) {
    el.classList.add("panel-hidden");
}

function showLoading(show) {
    if (show) {
        showPanel(loading);
    } else {
        hidePanel(loading);
    }
    generateBtn.disabled = show || !uploadedData;
    downloadBtn.disabled = show || !generatedSchedule;
}

function showWarnings(warnings) {
    warningsList.innerHTML = warnings
        .map(w => `<li>${escapeHtml(w)}</li>`)
        .join("");
    showPanel(warningsPanel);
}

function hideWarnings() {
    hidePanel(warningsPanel);
    // Clear after transition ends
    setTimeout(() => { warningsList.innerHTML = ""; }, 500);
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}
