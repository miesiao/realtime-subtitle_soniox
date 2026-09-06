# 即時字幕系統 — 商業化與資料模型規格（v2）

> 本文件是 `realtime-subtitle-spec.md`（技術層：角色 / utterance contract / viewer / host 顯示）的\*\*上層增補\*\*。
> 兩份互補：既有 spec 管「一場怎麼跑」，本文件管「多場、帳號、計費、逐字稿留存」。
> 術語沿用既有 spec：host（主講者）、viewer（聽眾）、utterance（一句 final 字幕）。

\---

## 0\. 一句話目標

個人會員登入後，可像 Google Meet 一樣**開一場即生成新亂碼網址**；聽眾掃 QR 匿名觀看即時翻譯；散場後（付費）自動整理逐字稿供回看下載。系統須支援**多場同時進行、彼此隔離**。

\---

## 1\. 商業模型定調（本階段的邊界）

|決定|選擇|理由|
|-|-|-|
|帳號模型|**個人會員**，不做組織 / 多成員 / RBAC|機構（咖啡館、旅行社、廠商）以「某個人的個人帳號」進來用即可，後端不需知道他是不是機構|
|付費主體|**User 本人**|額度、帳單、逐字稿都掛在 User|
|Room 概念|**不做持久房間**；Session = Room（Meet 模式），每次開播生成新亂碼、用完即拋|少一層狀態，心智模型最直覺|
|計費單位|**場次時長 × 目標語言數**（≈ 翻譯分鐘數）|這是 Soniox + Haiku 的真實邊際成本，定價須貼著它|
|免費 / 付費分界|**以「逐字稿留存」分界**（見 §6）|即時翻譯是當下服務，逐字稿是留存資產；願意為留存付錢的通常就是機構型客戶|
|會員分級旋鈕|**「同時可開幾場」= 純方案參數**（見 §5）|架構做對一次，分級只調數字|

**本階段明確不做**：組織帳號、成員邀請、角色權限、共用額度池、多聲道同房。

\---

## 2\. 資料表 Schema（四張）

### User

|欄位|型別|說明|
|-|-|-|
|`id`|PK（內部永久）|帳號主鍵|
|`email`|string, unique|登入帳號|
|`auth\_\*`|—|認證資料（依所選方案，如密碼雜湊 / OAuth sub）|
|`plan`|enum(`free`, `pro`, ...)|方案等級，決定額度與並發上限|
|`created\_at`|timestamp||

### Session（＝一場，計費發生在這層）

|欄位|型別|說明|
|-|-|-|
|`id`|PK（**內部永久主鍵**）|逐字稿、計費、擁有權都掛這；**永不進入公開網址**|
|`user\_id`|FK → User|擁有者|
|`name`|string|**可改名**；預設自動帶（如 `2026-09-06 中文場`），使用者可覆寫|
|`join\_code`|string, unique|**對外短亂碼**（如 `abc-defg-hjk`），聽眾用此進場；夠長、隨機、不可猜|
|`status`|enum|見 §4 狀態機|
|`source\_lang`|string|來源語言|
|`target\_langs`|string\[]|目標語言（可多語）|
|`cleaned\_transcript`|text, nullable|散場整理後的逐字稿（付費）|
|`processing\_status`|enum, nullable|`idle` / `processing` / `ready` / `failed`|
|`started\_at`|timestamp, nullable|開播時間（計費起點）|
|`ended\_at`|timestamp, nullable|散場時間（計費終點）|

### TranscriptLine（直播中逐句留存，append-only）

|欄位|型別|說明|
|-|-|-|
|`id`|PK||
|`session\_id`|FK → Session（**內部 id**）||
|`seq`|int|場內序號（沿用既有 utterance id 概念）|
|`ts`|timestamp||
|`original\_text`|text|**只認真存原文**（source of truth）；翻譯是衍生物，要用時再生|

> \*\*原則\*\*：只增不改（append-only）。直播中每句 final \*\*默默寫入\*\*，不影響前端顯示節奏。

### UsageLedger（每場散場結算一筆，append-only）

|欄位|型別|說明|
|-|-|-|
|`id`|PK||
|`user\_id`|FK → User||
|`session\_id`|FK → Session||
|`minutes`|number|本場時長|
|`num\_langs`|int|本場目標語言數|
|`created\_at`|timestamp||

> \*\*原則\*\*：永不修改舊紀錄。「本月用量」= 本月 ledger 加總。計費會被質疑，必須能逐筆攤開給客戶看數字怎麼來的。

\---

## 3\. 兩個 ID 的分離（重要架構原則）

每場有**兩個不同用途的識別碼，絕不共用**：

* **內部 `id`（永久、私有）**：關聯逐字稿 / 計費 / 擁有權。**永遠不放進公開網址**（否則會被猜號、遍歷）。
* **公開 `join\_code`（對外、亂碼）**：聽眾入場券，capability-based——**持有即可看，不驗身分**。

聽眾流程：掃 QR → 帶 `join\_code` 落地 → 後端把 `join\_code` 翻成內部 `id` → 檢查 `status` 是否 `live`。
散場不需要「讓 join\_code 過期」的額外邏輯——**聽眾能不能進，只看 `status` 是不是 `live`**。

\---

## 4\. Session 狀態機（＝核心流程）

```
created ──(host 開播)──▶ live ──(停止 / 靜音超時 / 額度見底)──▶ ended
                                                                  │
                                                       (付費才有)──▶ processing ──▶ ready
```

|狀態|含義|計費|聽眾可進？|
|-|-|-|-|
|`created`|已生成 join\_code + QR，尚未開播|否|否（顯示「尚未開始」）|
|`live`|Soniox 連上、計費時鐘啟動、TranscriptLine 累積|**是**|是|
|`ended`|散場，join\_code 不再可加入|否|否（顯示「本場已結束」）|
|`processing`|批次丟 Claude 整理逐字稿|否|否|
|`ready`|整理完成，host 可回看 / 下載|否|否|

**成本硬保護（必做，寫進 live 邏輯）**：

* 靜音自動斷線（超過 N 秒無語音 → 轉 `ended`）
* 單場時長上限
* 額度見底 → 自動停播

\---

## 5\. 多 Session 隔離（硬約束 — 針對現有 server.js 的重構）

> \*\*現況診斷\*\*：目前 `server.js` 是\*\*純單場架構、零隔離\*\*。兩場同時開會發生「資料串場」（字幕混場、host 互相覆蓋、清歷史連坐）。單場測正常，兩場並行才爆。

### 硬約束（給 Claude Code 的紅線）

> \*\*禁止任何 module-level 可變狀態（no global mutable state）。\*\*
> 所有 runtime 狀態（Soniox 連線、`viewers`、`history`、`hostWs`、`nextId`）\*\*必須掛在 session 實例上，以 `session\_id` 隔離\*\*。
> 廣播\*\*只能發給該 session 的 viewers\*\*。

### 重構對照（現有 → 目標）

|現有（`server.js` 行號）|問題|目標|
|-|-|-|
|`const soniox = new SonioxNodeClient()`（L18）|全域共用一條連線|每場自己的連線，綁在 session 物件|
|`let hostWs = null`（L108）|單一 host 插槽，第二個 host 覆蓋第一個|`session.hostWs`|
|`const viewers = new Set()`（L109）|所有聽眾同一 set，不分房|`session.viewers`|
|`const history = \[]`（L110）|全場字幕塞同一坨|`session.history`|
|`let nextId = 1`（L111）|全域序號|`session.nextId`（場內序號）|
|`broadcastToViewers`（L117–125）|廣播給所有連線|只遍歷 `session.viewers`|
|`history.push`（L136–138）|混場|寫入 `session.history` + `TranscriptLine(session\_id)`|
|`hostWs = ws`（L164）、`viewers.add`（L168）|無 session 歸屬|用 `join\_code` 找到 session 再掛入|
|`history.length = 0`（L197 clear）|清掉**所有**場的歷史|只清該 session|
|斷線清理（L234、L237）|動全域|動該 session|

### 建議結構

```
const sessions = new Map();  // key: session\_id → { hostWs, viewers:Set, history:\[], sonioxConn, nextId, ... }
```

* 每個 viewer / host 連線一進來，先用 `join\_code` 對應到 session\_id，取出（或建立）該 session 物件。
* 所有讀寫都經過 `sessions.get(session\_id)`，**任何地方都不再有裸露的全域字幕 / 連線變數**。
* session `ended` 時清掉 Map 裡的 runtime 物件（釋放記憶體），但**資料庫的 Session / TranscriptLine 原封不動保留**。

### 這一個重構同時解掉 B 和 A

* **B（不同 host 同時各開各的）**：不同 session\_id → 不同物件 → 天然隔離。
* **A（同一 host 開多場）**：系統只認「有幾個 session 物件活著」，不在乎屬於誰，**免費得到**。
* **會員分級**：「同時可開幾場」變成純數字上限，掛在 `User.plan`：

  * free：同時 1 場
  * pro：同時 N 場
  * 機構型：更高 N
架構不變，只調參數。

\---

## 6\. 逐字稿留存與散場整理

### 兩條管線必須分開（不可混用）

* **直播中（即時管線）**：Soniox → utterance → 廣播給 viewers，同時**默默** `append` 到 `TranscriptLine`。追求快、順，**絕不可為了整理漂亮而延遲字幕**。
* **散場後（批次管線）**：`ended` 觸發 → 讀出該 session 全部 `TranscriptLine.original\_text` → **再送一次 Claude** 整理（分段 / 去口頭禪贅字 / 補標點 / 下小標 / 摘要）→ 寫回 `Session.cleaned\_transcript` → `status = ready`。批次、不趕時間，可用較好的模型。

### 隱私與權限

* 逐字稿**只有開播的 host 本人可見**；viewer 看不到歷史留存。
* **主逐字稿只認原文那條**（source of truth），翻譯為衍生物。

### 「可改名 / 歷史場次 / 逐字稿」是同一個畫面

使用者事後回來的地方是**一張自己的場次清單**，在那裡：改名、看狀態、（付費）讀整理好的逐字稿、下載。不是三個功能，是一頁。

\---

## 7\. 免費 / 付費分界

||免費（free）|付費（pro / 機構型）|
|-|-|-|
|即時字幕|✅|✅|
|開場 / 掃碼觀看|✅|✅|
|同時可開場數|1|N（分級）|
|每月分鐘數|有硬上限|更高 / 加購|
|散場逐字稿留存|❌（散場即消失）|✅ 自動整理、可回看下載|
|浮水印|可加|無|

免費層是拉新利器，但燒的是你的 Soniox / Haiku 成本 → **必須有硬上限**（分鐘封頂、靜音斷線、聽眾人數上限）。

\---

## 8\. 兩條使用者動線

* **Host**：登入 →「開新場次」→ 拿 join\_code / QR（可改名）→ 開播（`live`）→ 停止（`ended`）→（付費）回歷史清單看整理好的逐字稿。
* **Viewer**：掃 QR → 帶 join\_code 落地 → `live` 就選語言看雙欄字幕；`ended` 就看到「本場已結束」。

\---

## 9\. 建議施作順序（先做能動的再迭代）

> 每階段都在「多 session 隔離」的地基上做，\*\*第一階段就先把全域狀態重構掉\*\*，不要等。

1. **場次骨架 + 多 session 隔離（地基）**

   * 建 `sessions` Map，把現有全域狀態全部搬進 session 物件（§5 重構對照）。
   * `create → 生 join\_code + QR → start/stop` 狀態機。
   * 把**現成的 Soniox**（既有 spec 已完成的部分）包進 `live`，每場一條連線。
   * 驗收：**兩場同時開，字幕不串場、清歷史不連坐**。
2. **逐字稿留存 + 散場整理**

   * `live` 中每句 final append 到 `TranscriptLine`。
   * `ended` 觸發批次任務 → Claude 整理 → 寫回 `cleaned\_transcript` → `ready`。
   * 場次清單頁（改名 / 看狀態 / 讀逐字稿 / 下載）。
3. **帳號與計費**

   * 登入、`User.plan`、額度扣減（讀 UsageLedger 加總）。
   * 並發上限（`plan` → 同時可開場數）。
   * 把「逐字稿留存」設成付費牆。
   * 成本硬保護：靜音斷線、單場上限、額度見底停播。
   * 拆止血：正式登入上線後，\*\*移除主線的臨時 `HOST\_SECRET` 密碼牆\*\*，改由帳號登入驗證 `/api/temporary-key`。不可讓「臨時共用密碼」與「正式帳號登入」兩套 auth 並存——最容易留下沒收乾淨的舊入口。
   * 驗收：`curl -X POST /api/temporary-key`（不帶登入）須回 401；確認舊的 `x-host-secret` 路徑已無效。

\---

## 附：可直接餵給 Claude Code 的核心指令摘要

> 建立 `sessions = new Map()`，key 為 session\_id。移除 `server.js` 中所有 module-level 的 `hostWs` / `viewers` / `history` / `nextId` / 共用 `soniox`，改為每個 session 物件各自持有。廣播只發給 `session.viewers`。聽眾以 `join\_code` 對應 session，不得將內部 `id` 放入任何公開網址。禁止任何全域可變狀態。

