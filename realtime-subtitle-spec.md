# 即時字幕系統 — 開發規格（Soniox 版，host / viewer 產品化）

> 交給 Claude Code 的規格。基礎是 `realtime-subtitle_soniox` 這個 MVP。
> 舊專案 `realtime-subtitle` **只當視覺與優化的參考來源**，不是照抄藍本。
> 本文所有「搬 / 丟」的判斷都已針對「Soniox 取代 Web Speech」這個架構改變做過調整。

---

## 0. 一句話目標

把目前的單頁 Soniox 測試工具，長成「**host 講、N 支觀眾手機看字幕**」的產品：host 用 Soniox 聽寫（＋視情況翻譯），server 廣播給所有 viewer，viewer 用雙區呈現、可切語言、可回捲歷史。

---

## 1. 整體架構（三個角色）

```
Host 瀏覽器                     Server (Node)                 Viewer 瀏覽器 × N
─────────────                   ──────────────                ─────────────────
麥克風 → Soniox Web SDK   ──WS──▶  接收 host 的 utterance
(拿臨時金鑰、聽寫)                 ├─ 一段式：直接廣播
                                  ├─ 兩段式：呼叫 Haiku fan-out   ──WS──▶  雙區字幕顯示
                                  └─ 快取最近 N 句（給晚進場/回捲）        (選語言、回捲載入歷史)
```

- **Host 瀏覽器**：唯一持有麥克風、跑 Soniox Web SDK 的地方。臨時金鑰機制沿用 MVP 現有的 `/api/temporary-key`。
- **Server**：不碰音訊。只負責 (a) 收 host 的句子、(b) 兩段式時呼叫 Haiku、(c) 廣播給 viewers、(d) 快取最近 N 句歷史。Anthropic 金鑰只在這裡。
- **Viewer**：只接收、只顯示，永遠不知道譯文是 Soniox 生的還是 Haiku 生的（見 §3 統一契約）。

---

## 2. 翻譯策略分岔（唯一的架構分支）

分岔規則只看一件事：**這場 host 開了幾種輸出語言。**

| 情境 | 策略 | Soniox 設定 | 翻譯在哪 |
|---|---|---|---|
| 單一輸出語言 | 一段式 | 開 `translation`（one_way） | Soniox 在 host 瀏覽器直接翻 |
| 2 種以上輸出語言 | 兩段式 | **不開** `translation`（純聽寫） | Server 呼叫 Haiku 一次翻齊所有語言 |

- 兩段式**不要**用「Soniox 翻一個 + Haiku 翻其他」的混血法（來源不一致、延遲不對齊、合併邏輯複雜）。2 種以上就**全部交給 Haiku**。
- Soniox 翻不翻，只是 host 建立連線時 config 要不要塞 `translation` 區塊的差別，不是兩套連線程式。

---

## 3. 統一輸出契約（讓分岔被關進盒子）

不論一段式或兩段式，**server 廣播給 viewer 的資料形狀永遠一致**：

```json
{
  "type": "utterance",
  "id": "單調遞增或 uuid",
  "ts": 1699999999,
  "original": "講者實際講的話（若為中文，已繁化）",
  "translations": { "zh": "……", "en": "……" }
}
```

- Viewer 只認這個格式，用選定語言去取 `translations[選定語言]`，對照模式再額外顯示 `original`。
- 一段式時 `translations` 只有一個 key；兩段式時有多個 key。Viewer 端邏輯完全相同。
- 未來要換第三種翻譯來源，只要 server 端照這個契約產出即可，viewer 一行都不用改。

### 非最終（interim）token 的處理
- Soniox 會吐 non-final token（邊講邊改）。**最新一句**允許用 interim 逐字浮現（見 §5 呈現）。
- 但 interim **只在 host 端本地或最新句顯示**；廣播給 viewer 的「定稿句」以 Soniox `is_final` / endpoint 為準，避免把會變動的文字塞進歷史。

---

## 4. Server 端要做的事

1. **兩種 WS 角色**：`host` 與 `viewer`（沿用舊專案的 register 模式）。
2. **接收 host 的 final utterance**：
   - 一段式：host 已附譯文 → 直接組成 §3 契約廣播。
   - 兩段式：host 只給 original → 呼叫 Haiku fan-out 翻成所有開放語言 → 組成契約廣播。
3. **Haiku fan-out**（僅兩段式）：
   - 用 `claude-haiku-4-5`。
   - **沿用舊專案的滾動上下文概念**：帶最近數句當 `[前文參考]`（舊 `recentFinals` 是 3 句，可調）。
   - **一次呼叫翻齊所有目標語言**（要求回 JSON：`{"zh":"…","en":"…"}`），不要每語言各呼叫一次。
   - 建議對固定的 system prompt 開 **prompt caching** 省成本。
4. **歷史快取**：保留最近 N 句 utterance（例如 N=50，可調）。
   - 新 viewer 連上 → 先推最近幾句（例如 10 句）當「墊場」，不要一次全推。
   - Viewer 回捲觸頂 → 用 `{type:"history_request", before:<id>}` 向 server 要更早的句子，server 回一批（分頁懶載入）。
5. **繁化**：中文（original 或任何譯文）在**送出前或 viewer 顯示前**過 OpenCC（`cn→twp`）。MVP 已有 opencc-js，沿用。建議統一在**一個地方**做（server 送出前最乾淨，viewer 就不必各自轉）。

---

## 5. Viewer 端規格

### 5.1 版面（搬舊 viewer 的雙區，這是核心優化）
- **上 3/4：歷史區**。字較小、灰、頂端用 `mask-image` 線性漸層淡出；內容錨定在底部往上堆疊。
- **下 1/4：最新句區**。字大、加粗、亮，有 `riseIn` 浮現動畫。
- 對照模式下，最新句區同時顯示 `original`（上）與 `translations[選定語言]`（下）。

### 5.2 唯一的顯示切換
- **「顯示原文」開關**：開＝原文＋譯文對照；關＝只看譯文。**預設開。**
- 沒有別的「模式」。（歷史回捲不是模式，是下面 5.4 的固定行為。）

### 5.3 字幕如何「長出來」
- 最新一句：用 Soniox non-final token **逐字浮現**（跟著講者即時長）。
- 該句 `is_final` / endpoint 一到 → **定稿**、往上推進歷史區，下一句開始浮現。
- 這樣同時有「即時感」（逐字）與「好讀」（定稿整句）。

### 5.4 歷史與晚進場（固定行為，非選項）
- 進場：先顯示最近幾句（server 推的墊場句），不要空白等待。
- 回捲：往上滑觸頂 → 向 server 要更早的句子，**懶載入**接上去。
- 不做「整段聊天記錄一次塞滿」。

### 5.5 觀眾語言切換（host 開 2+ 語言時才出現）
- 頂部給語言切換。
- **切換是純前端重繪**：因為每句 utterance 的 `translations` 已含所有語言，切語言只是改「取哪個 key」→ 立即重繪，**不需重新請求或重新翻譯**。
- **整個歷史一起變成新語言**（不會上半英文、下半中文）；對照模式下 `original` 不受影響、只換譯文那半。

### 5.6 其他必備
- **Wake Lock**（沿用舊 viewer）：防手機休眠。
- **斷線自動重連**（舊專案沒有、**必須新增**）：戶外網路會晃。重連時給不嚇人的提示，重連後補回錯過的句子（用 §4 歷史快取）。
- **切後台再回來**能接回、不空白。
- 字體大、對比高，可再放大（戶外強光）。

---

## 6. Host 端規格

- **入口門檻**：舊專案用 4 位數 passcode（且**硬編在前端**，任何人看原始碼就知道）。可沿用作為輕量門檻，但**別當真正的安全**；若要更嚴，改成 server 端驗證。
- **語言設定**：這場開哪幾種輸出語言（決定走一段式或兩段式）。
- **麥克風 / Soniox**：沿用 MVP 的 Soniox Web SDK 擷取＋臨時金鑰。config：`stt-rt-v5`、`language_hints:['zh','en','es']`、`enable_language_identification`、`enable_endpoint_detection`；一段式才加 `translation`。
- **狀態監看（戶外關鍵）**：明確的「正在收音 / 正在吐字 / 連線正常」狀態燈——host 最怕「其實斷了但不知道」。
- **QR code**：讓觀眾掃碼進 viewer。
- **連線數**：顯示目前幾支 viewer 在線。
- **自己校對用**：host 畫面顯示原文＋各譯文，辨識歪了當場看得到。
- **Start / Stop**：語言組合在 Start 前決定；要改中途 Stop 再 Start（Soniox 一條串流的 config 不能中途改）。

---

## 7. 從舊專案「搬 / 丟」清單（已針對新架構判斷）

### ✅ 搬（真優化，跟架構無關）
- 雙區呈現版面（大最新句 + 淡出歷史）
- Wake Lock
- 歷史頂端 mask 漸層淡出
- 中文標點斷句（`splitSentences`：`。！？`）
- 滾動上下文「概念」→ 移到**兩段式的 Haiku** 那層

### ⚠️ 搬但只放對地方
- **字幕節奏佇列**（`enqueueSubtitle`/`showNext`/`getBuffer`）：
  - **只用在兩段式**（Haiku 一段段吐、會湧入 → 需要平滑）。
  - **一段式不要用**（Soniox token 逐字串流本來就平滑，加了反而多餘）。

### ❌ 丟（Web Speech 的補丁 / 成本坑）
- **client 端 force-send + 去重**（`forceSendInterim` / `forcedText` / `forceOffset`）：純 Web Speech 遲吐 final 的 workaround。Soniox 有 endpointing / `is_final`，整組不要，硬搬會跟 Soniox 斷句打架。
- **Web Speech API**：已被 Soniox 取代。
- **背景 `reprocessHistory`**（每 3 秒重翻整段）：成本坑，先不做（未來若要，改成「散場後一次性整稿」的 opt-in，不要即時跑）。

### 🟢 MVP 已有、保留
- 臨時金鑰 `/api/temporary-key`（`transcribe_websocket`、300s）
- OpenCC 強制繁化（`cn→twp`）
- Soniox 診斷 badge（開發期看 Soniox 原始出繁/簡，可保留在 host 校對區）

---

## 8. 明確「本階段不做」（避免 Claude Code 自作主張）
- **音訊轉播 / 原聲廣播 / 語音轉語音**：另案處理，本專案不碰。
- **散場後 AI 整稿**：未來 opt-in，現在不做。
- 多目標語言用「開多條 Soniox 串流」的作法：不採用（改用兩段式 Haiku）。

---

## 9. 建議施作順序
1. **連接骨架**：host/viewer 兩角色、server 廣播、§3 統一契約、歷史快取。
2. **一段式打通**：host Soniox 開翻譯 → 廣播 → viewer 雙區顯示（先單語言、能動）。
3. **viewer 呈現優化**：雙區、逐字浮現/定稿、mask、wake lock、斷線重連、懶載入歷史。
4. **兩段式**：host 純聽寫 → server Haiku fan-out（含滾動上下文、prompt caching）→ 多語言 + viewer 語言切換 + 節奏佇列。
5. **host 控制台**：狀態燈、QR、連線數、校對區。

每一步做完先能跑、先驗證，再進下一步。
