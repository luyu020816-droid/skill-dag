# 发布 & 推广计划（Getting Stars & Downloads Fast）

目标：**最快获得 star + npm 下载量**。核心策略是抢占「**首个 GraSP 开源实现**」的心智 + 双渠道上架（npm + dsh-market）+ 内容营销。

## 一、发布清单（按顺序）

### 1. GitHub 建仓（先做，README 就是门面）

```sh
cd D:\dsh\grasp-release
git init
git add -A
git commit -m "feat: first open-source GraSP implementation — skill-dag core + DSH plugin"
# 在 github.com 建一个 public 仓库，名字建议：skill-dag（或 grasp-agent）
git remote add origin git@github.com:luyu020816-droid/skill-dag.git
git branch -M main
git push -u origin main
```

提交前必做：
- [x] README 顶部徽章链接已换成真实用户名 `luyu020816-droid`（skill-dag）
- [ ] 加一张 **demo 截图/GIF**（README 里那张 SVG 图的截图即可；有动图更好）——**有图 vs 没图的 star 差 3-5 倍**
- [ ] GitHub repo 设置里加 **topics**：`grasp`、`llm-agent`、`skill`、`dag`、`planning`、`deepseek-harness`

### 2. npm 发布核心包

```sh
cd D:\dsh\grasp-release\skill-dag
# 第一次需要：npm adduser（一次即可）
npm publish
# 验证：npm view skill-dag
```

- 名字先查重：`npm view skill-dag`（若被占用，改 `@luyu020816-droid/skill-dag` 或 `grasp-dag`）
- 后续版本：改 `version`（`npm version patch/minor/major`）再 `npm publish`

### 3. DSH 插件 bundle（plugins/skill-dag-dsh/，已构建验证通过 ✅）

- 结构：`cordis.patch.yml`（`dsh.bundle.patch`）+ `dsh.client {platform: web}` + `exports["./client"]` lazy-CJS factory + `screenshots.json`（相对路径图片，禁 `..`）
- **构建已验证**：`npm install && npm run build` 全绿——产物 `lib/index.js`（44KB host ESM，skill-dag 核心已内联，用户零依赖）+ `lib/client.js`（8.9KB lazy-CJS factory）+ `lib/types/`（声明）；`npm pack --dry-run` 13 文件 31.5kB；Node 冒烟加载 `name=grasp / inject / apply` 全部正确
- 关键修正（与最初草稿不同）：peerDependencies 实际版本是 `cordis ^4.0.1`、`dsh-tools ^0.1.0-rc.2 || ^0.1.1-rc.2`（原写的 rc.5/rc.7 不存在）；`skill-dag` 移入 devDependencies 由 tsdown 内联，避免发布顺序依赖；tsdown 用官方双 build 结构 + `entryFileNames` 固定 `lib/index.js`/`lib/client.js`
- 发布为独立 npm 包 `skill-dag-dsh`（`repository` 字段必须指回本仓库，否则与市场条目无法关联）

```sh
cd D:\dsh\grasp-release\plugins\skill-dag-dsh
npm install
npm run build        # ✅ 已验证
npm publish          # 需要先 npm login
# 验证：npm view skill-dag-dsh
```

### 4. awesome-dsh-plugin 上架（让 dsh-market 收录）

前置门槛（CI 自动检查）：
- [ ] 仓库 `package.json` 声明 `dsh.bundle`（在根或 `packages/`·`plugins/`·`apps/` 子目录——注意是**复数** `plugins/`，本仓库已按此布局）
- [ ] 仓库创建满 **1 天** 且 **≥10 commits**（已凑够 10 个）
- [ ] repo 加 **`dsh-plugin` topic**
- [ ] 只有 `dsh.client` 会被拒；必须有 `dsh.bundle`

PR 步骤（在 awesome-dsh-plugin 仓库）：
1. 新建 `data/plugins/luyu020816-droid__skill-dag--plugins-skill-dag-dsh.yml`（monorepo 子包格式，草稿在 `docs/awesome-dsh-plugin-entry.yml`，复制即可）
2. `npm ci && node scripts/generate-readme.mjs` 重新生成 README 一并提交（README 是生成的，勿手改）
3. 提交 PR；一个 PR 最多 3 条 entry
4. 合并后 dsh-market 自动收录（约一天内），DSH 用户 设置→Plugin Market 可搜到

截图：可选但强烈推荐——仓库自带 `screenshots.json`（1-8 张，路径相对该文件、不能含 `..`、不能跳出插件目录）。本仓库已声明 `plugins/skill-dag-dsh/screenshots.json` → `assets/` 下 PNG+SVG。

## 二、推广策略（热度来源）

### 定位一句话
> **首个开源 GraSP 实现：把散文技能零标注编译成可执行 DAG，接 DeepSeek Harness 真实 LLM。**

「首个实现」+「Tencent 2026 论文」+「零标注」三个钩子，是冷启动的注意力来源。

### 内容渠道（按性价比排序）

| 渠道 | 动作 | 预期 |
|---|---|---|
| **掘金** | 技术文：《复刻腾讯 GraSP：把散文技能编译成 DAG，我踩的 4 个坑》——把 scope/谓词一致性/goal 绑定/client scope 四个真问题写出来，附 repo 链接 | 中文开发者主流量 |
| **Hacker News** | Show HN: "First open-source implementation of Tencent's GraSP (skill → typed DAG compiler)" | 国际流量峰值 |
| **Reddit** | r/MachineLearning、r/LocalLLaMA：贴 README + demo 图 | 论文读者 |
| **知乎/V2EX** | 简短提问式帖 + repo 链接 | 讨论热度 |
| **DSH 社区** | DSH Discord/forum、awesome-dsh-plugin 讨论 | 精准用户（会安装的人） |

### 内容三件套（复用）
1. **Demo GIF**（编译 → 出图 → 拖拽）——README 和所有帖子都用它
2. **技术博客**（4 个坑的故事）——可信度锚点，证明不是纸面复刻
3. **对比表**（vs 论文数字 0.4831/0.9009/0.3248）——「精确复现」是最强的信任状

### 时机
论文 2026-04 发布，**「首个开源」窗口期有限**——发布后 2-3 周内密集铺内容，抢占搜索和讨论心智。

## 三、诚实边界（README 已写，别删）

- unofficial reproduction，超参数 w/b 为经验值
- LLM 推断谓词是符号性的，散文技能是 best-effort
- token Jaccard 非 embedding 检索
- 这些「已知限制」反而是可信度来源，删了反而像夸大

## 四、验收指标（发布后 2 周）

- GitHub stars > 50（内容铺完的正常水位）
- npm downloads > 200
- awesome-dsh-plugin PR 被合并（dsh-market 可见）
