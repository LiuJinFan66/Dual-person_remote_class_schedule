# 我们的课表 · 蓝粉双色合并（H5）

把两人的课表拼成一张 **蓝（我）/ 粉（对象）** 双色周课表，按**真实日期**查看某一周的课，一眼看清谁有课、谁没课、谁俩都空。截图自动识别（智谱 GLM-4V-Flash），云端共用一份，全程零费用。

## 功能

- 手机端 H5 网页，微信/任意浏览器直接打开
- 上传课表截图 → AI 自动识别：课程名 / 星期 / 节次 / 周次范围（如 1-16 周、单双周）/ 地点
- **每门课支持任意周次范围 + 单/双周**
- **每人设置「本学期第 1 周周一」**，系统把「第 N 周」自动换算成真实日期
- **按日历选择具体日期**，查看该日期所在那一周（周一~周日）的课
- **不同学校周次不一致时，按真实日期对齐**（各用各的开学日期换算）
- 蓝粉双色合并，空闲格清晰标注；可分别显示/隐藏某一方
- 云端共用同一房间，两人各自上传，10 秒自动同步

## 成本（全部免费）

- 托管：Cloudflare Pages（无限带宽、HTTPS）
- 函数：Cloudflare Pages Functions（10 万请求/天）
- 存储：Cloudflare KV 免费档
- 识别：智谱 GLM-4V-Flash 免费额度（手机号注册即得）

## 数据结构（存于 Cloudflare KV，key = 房间号）

```json
{
  "blue": {
    "startDate": "2026-09-07",
    "courses": [
      { "name": "高等数学", "day": 1, "start": 1, "end": 2,
        "loc": "A201", "teacher": "王", "weekStart": 1, "weekEnd": 16, "weekType": "all" }
    ]
  },
  "pink": { "startDate": null, "courses": [] }
}
```
- `weekType`：`all` 全周 / `odd` 单周 / `even` 双周
- `startDate`：该侧「第 1 周周一」日期；不同学校可不同，按真实日期对齐

## 部署步骤

### 1. 领取智谱免费 Key
打开 <https://open.bigmodel.cn> 手机号注册 → 用户中心 → API Keys → 创建。Key 形如 `xxxx.yyyy`（带点）。**这个 Key 是机密，绝不写进仓库。**

### 2. 创建 Cloudflare KV
控制台 → Workers & Pages → KV → 创建命名空间（名字随意，如 `kebiao`），或命令行：
```bash
npx wrangler kv namespace create SCHEDULE_KV
```
拿到 32 位命名空间 ID，填进 `wrangler.toml` 的 `id`（本项目已填好 `kebiao` 的 ID）。

### 3. 部署到 Cloudflare Pages
1. 把本目录推到 GitHub 仓库
2. 控制台 → Workers & Pages → Create application → 底部 **Continue to Pages** → Connect to Git
3. Framework preset 选 **None**；Build command **留空**；**Build output directory 填 `.`**
4. 部署后，KV 绑定已在 `wrangler.toml` 里声明（项目为 wrangler.toml 托管绑定）
5. 用命令行设置机密（不要写进仓库）：
```bash
npx wrangler pages secret put ZHIPUAI_API_KEY --project-name <你的项目名>
```
6. 重新部署一次（Deployments → Retry deployment）使配置生效

### 4. 使用
1. 打开 Pages 域名，点右上「分享」复制带房间号的链接发给对象
2. 两人打开同一链接，各自选「蓝/粉」
3. **填「本学期第 1 周周一」** → 上传课表截图 → 识别 → 核对（尤其确认周次范围）→ 保存
4. 顶部用日期选择器（‹ 日期 › 本周）翻看任意一周，蓝粉课表按真实日期对齐显示

## 目录结构
```
index.html              移动端页面
styles.css              蓝粉主题与课表网格样式
app.js                 前端逻辑（房间/识别/日期换算/周次过滤/网格/轮询）
functions/api/recognize.js  调智谱 GLM-4V 识别（含周次）
functions/api/room.js       KV 读写两人课表（startDate + courses）
wrangler.toml           KV 绑定配置
```

## 说明与隐私
- 云端只保存课表文本（课程名/时间/地点/周次），不含身份信息
- 房间用随机 6 位 ID，知道链接的人都能读写该房间，请勿外传
- 不同学校「节次→具体时间」可能不同，默认映射在 `app.js` 的 `SLOTS` 里可改
- 如切换/更换节次时间表，两侧可各自调整，互不影响
