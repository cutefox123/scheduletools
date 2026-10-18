# 查班小助手 · PWA（iOS 版）

给 iPhone 用的网页版：导入科室排班表（xlsx / xls），看一周班次、搭档、天气，并把班次**导出到系统日历**做提醒。
纯静态站点，可以挂在 **Gitee Pages** 上；所有数据只存在手机本地（localStorage），不上传服务器。

---

## 一、为什么是“导出到日历”，而不是推送通知

iOS 上的网页应用（PWA）有几个硬限制，必须绕开：

| 想要 | iOS PWA 能不能 | 这里的做法 |
|---|---|---|
| 后台定时弹提醒（像安卓闹钟） | ❌ 不能 | **导出 .ics 到系统日历**，由日历到点提醒（和安卓版的“日历双保险”一个思路） |
| 锁屏/后台推送 | ⚠️ 仅 iOS 16.4+ 且需服务端（Gitee Pages 是纯静态，没有后端） | 暂不做；需要的话得另加一个推送服务 |
| 后台刷新数据 | ❌ 基本不行 | 打开 App 时自动补拉天气（open-meteo，支持 CORS） |
| 本地存数据 | ✅ 可以 | localStorage（表 + 姓名 + 天气缓存） |
| 断网可用 | ✅ 可以 | Service Worker 缓存整个壳 |

**结论**：提醒靠「导出到日历」——点一次「导出到日历」生成 `.ics`，用「文件」打开后系统日历会问是否添加，之后到点由 iOS 提醒你。

---

## 二、部署到 Gitee Pages

前提：Gitee 仓库**公开**、账号已实名认证、仓库里开了 Pages。

1. 新建仓库（例如 `chaban`），把本目录内容推到仓库根目录（或 `docs/` 子目录）：
   ```bash
   git init
   git add .
   git commit -m "chaban pwa"
   git remote add origin https://gitee.com/<你的用户名>/chaban.git
   git push -u origin master
   ```
2. 仓库页 → **服务 → Gitee Pages** → 部署分支 `master`、部署目录（根目录就填 `/`）→ 勾选强制 HTTPS → **启动服务**。
3. 访问地址形如：`https://<你的用户名>.gitee.io/chaban/`
4. 以后每次改代码推送后，Gitee Pages 需要**手动点一次「更新」**才会重新部署（免费版没有自动部署）。

> 小提示：
> - `manifest.webmanifest` 里的 `start_url` 是 `./`，放在子目录也能正常工作。
> - 站点如果开在子目录，`sw.js` 的缓存路径都是相对路径，不受影响。
> - Gitee Pages 对静态文件有缓存，改完看不到更新时用「无痕窗口」或加 `?v=2` 试。

---

## 三、在 iPhone 上装成“App”

1. Safari 打开上面的地址；
2. 底部 **分享** → **添加到主屏幕**；
3. 之后从桌面图标打开即是全屏无地址栏（`display: standalone`）。

> 用 Safari 标签页也能用，只是没有全屏；**导出日历**在两种模式下都能用。

---

## 四、日常使用

1. 微信里点开排班 xlsx → 右上角「···」→「用其他应用打开」→「存储到“文件”」；
2. 打开本 App → **导入排班表** → 从「文件」里选刚存的那张 → 选「医生排班表」或「报告员表」；
3. 顶部输入姓名 → **查询**（下面可切「医生 / 报告员」）；
4. 想看搭档、天气：日卡上直接就有；
5. 要提醒：**导出到日历** → 打开生成的 `.ics` → 日历里「添加全部」。

---

## 五、目录结构

```
index.html              页面骨架（含 iOS meta、apple-touch-icon）
styles.css              样式（移动优先，适配刘海屏安全区）
manifest.webmanifest    PWA 清单（standalone / 图标 / 主题色）
sw.js                   Service Worker（离线缓存）
js/app.js               主逻辑：导入、渲染、查询、导出日历、设置
js/weather.js           天气（open-meteo，含过去几天，支持 CORS）
js/xlsx.js              xlsx 解析（zip + xml，零依赖）
js/xls.js               xls 解析（OLE2/BIFF8，零依赖，移植自 Android 版）
js/parser.js            排班规则（白/中/夜/下夜/休、上班时间、中班 12:00-13:30、病房 +30 分钟）
js/rooms.js             诊室目录 / 诊室一周明细（含“床旁”规则）
icons/                  图标（180/192/512 + maskable）
expected/               移植时的“标准答案”JSON（来自 Java 版，用于回归校验）
tools/                  图标生成、解析一致性校验脚本
```

---

## 六、本地预览

```bash
cd E:\traeproject\ScheduleAssistantPwa
python -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080
```

> 必须用 http 服务打开，直接双击 `index.html`（file://）会让 Service Worker 和 ES module 失效。

---

## 七、和安卓版的关系

- 解析规则（`ScheduleParser / ReporterParser / RoomDirectory`）是**从 Java 版逐条移植**的，用第 39/41 周真实表做过逐字段比对（见 `expected/`）；
- 差异：安卓版有本地闹钟 + 系统日历双保险；iOS PWA 只保留“系统日历”这一条路（靠 .ics 导出）。
