# 我们的课表 · 蓝粉双色合并（H5）

把两人的课表截图拼成一张 **蓝（我）/ 粉（对象）** 双色周课表，一眼看清谁有课、谁没课、谁俩都空。拍照自动识别（智谱 GLM-4V-Flash），云端共用一份，全程零费用。

## 功能

- 手机端 H5 网页，微信/任意浏览器直接打开
- 上传课表截图 → AI 自动识别课程名/星期/节次/地点/周次
- 识别结果可逐条核对、修改、增删
- 蓝粉双色合并周课表，空闲格清晰标注
- 支持「全周 / 单周 / 双周」视图切换
- 云端共用同一房间，两人各自上传，10 秒自动同步

## 成本（全部免费）

- 托管：Cloudflare Pages（无限带宽、HTTPS）
- 函数：Cloudflare Pages Functions（10 万请求/天）
- 存储：Cloudflare KV 免费档
- 识别：智谱 GLM-4V-Flash 免费额度（手机号注册即得）

## 部署步骤

### 1. 领取智谱免费 Key

1. 打开 <https://open.bigmodel.cn> 用手机号注册
2. 进入「用户中心 → API Keys」创建一个 Key
3. 记下这个 Key（形如 `xxx.yyy.zzz`）

### 2. 创建 Cloudflare KV

```bash
212ba40c7f004058bd1d417336c3ab50.Kz7YLq1mQJk1W84m
```

记下输出里的 `id`（如 `a1b2c3d4...`），填进 `wrangler.toml` 的 `id = "REPLACE_WITH_YOUR_KV_ID"`。

### 3. 部署到 Cloudflare Pages

方式 A（推荐，最简单）：

1. 把本目录推到 GitHub 仓库
2. Cloudflare 控制台 → Workers & Pages → 创建 → Pages → 连接 Git 仓库
3. 构建命令留空，输出目录填 `.`（因为就是静态文件）
4. 部署完成后，进入项目 → 设置 → 绑定 → KV，绑定命名空间 `SCHEDULE_KV`，变量名填 `SCHEDULE_KV`
5. 同页面 → 环境变量，添加 `ZHIPUAI_API_KEY` = 你的智谱 Key
6. 重新部署一次使配置生效

方式 B（命令行）：

```bash
npx wrangler pages deploy . --project-name couple-schedule
```

并在 Cloudflare 控制台为该项目绑定 KV（`SCHEDULE_KV`）与变量 `ZHIPUAI_API_KEY`。

### 4. 使用

1. 打开你的 Pages 域名（如 `https://couple-schedule.pages.dev`）
2. 点右上角「分享」复制带房间号的链接，发给对象
3. 两人打开同一链接，各自选「蓝（我）/ 粉（对象）」上传课表截图
4. 核对识别结果 → 保存 → 合并课表自动出现，空闲一目了然

## 目录结构

```
index.html              移动端页面
styles.css              蓝粉主题与课表网格样式
app.js                 前端逻辑（房间/上传/识别预览/合并网格/轮询）
functions/api/recognize.js  调智谱 GLM-4V 识别
functions/api/room.js       KV 读写两人课表
wrangler.toml           KV 绑定配置
```

## 说明与隐私

- 云端只保存课表文本（课程名/时间/地点），不含身份信息
- 房间用随机 6 位 ID，知道链接的人都能读写该房间，请勿外传
- 不同学校「节次→具体时间」可能不同，默认时间映射可在 `app.js` 的 `SLOTS` 中调整
