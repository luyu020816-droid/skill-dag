# DEPLOY.md — 发布执行手册（复制粘贴即可）

> 目标：GitHub 建仓 → npm 双包发布 → awesome-dsh-plugin 上架 → 内容铺开。
> 全程在 **cmd** 里复制粘贴；已避开 `cd` 不切盘符、`#` 注释、`<占位符>` 重定向三个坑。
> 所有命令已用真实用户名 `luyu020816-droid` 填好。

---

## 0. 前置检查（一次）

```cmd
node --version
git --version
npm login
```

`npm login` 需要浏览器登录 npmjs.com（用户名/密码/OTP）。不登录则第 3 步失败。

---

## 1. 本地构建验证（插件 bundle）

```cmd
cd /d D:\dsh\grasp-release\plugins\skill-dag-dsh
npm install
npm run build
```

预期输出结尾：
```
✔ [skill-dag-dsh/client] Build complete
✔ [skill-dag-dsh] Build complete
[skill-dag-dsh] normalized ...\lib\client.js (... bytes)
```

**失败就看这一行往上**：多数是网络（重跑 `npm install`）或 peer 冲突（把报错发回来）。

---

## 2. GitHub 建仓 + push

先在浏览器里打开 https://github.com/new ：
- Repository name: `skill-dag`
- Public
- **不要**勾选 README / .gitignore / license（仓库里已有）

然后：

```cmd
cd /d D:\dsh\grasp-release
git remote add origin git@github.com:luyu020816-droid/skill-dag.git
git branch -M main
git push -u origin main
```

- 如果 SSH 报权限错误：改用 HTTPS 远程（`git remote set-url origin https://github.com/luyu020816-droid/skill-dag.git`），push 时按提示登录。
- push 后浏览器打开 https://github.com/luyu020816-droid/skill-dag/settings/topics 添加：
  `grasp`、`dsh-plugin`、`deepseek-harness`、`planning`、`llm-agent`、`skill`

---

## 3. npm 发布（先核心包，后插件包）

```cmd
cd /d D:\dsh\grasp-release\skill-dag
npm publish
npm view skill-dag

cd /d D:\dsh\grasp-release\plugins\skill-dag-dsh
npm publish
npm view skill-dag-dsh
```

- 名字已确认可用（发布前查过：`skill-dag` 和 `skill-dag-dsh` 均 404 未占用）。
- 插件包发布时 `prepack` 会自动重新构建，无需手动 build。
- 以后改代码升级版本：`npm version patch`（或 minor/major）再 `npm publish`。

---

## 4. awesome-dsh-plugin 上架（让 dsh-market 收录）

前置门槛（已全部满足）：
- [x] `dsh.bundle` 在 `plugins/` 子目录（CI 扫描的合法位置）
- [x] 仓库 13+ commits（要求 ≥10）
- [x] `dsh-plugin` topic（第 2 步添加）
- [ ] 仓库创建满 **1 天**（建仓后等 24 小时再提 PR，否则 CI 自动拒）

PR 步骤：
1. Fork [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
2. 在 fork 里新建 `data/plugins/luyu020816-droid__skill-dag--plugins-skill-dag-dsh.yml`，内容复制自本仓库 `docs/awesome-dsh-plugin-entry.yml`
3. 在 fork 根目录跑：
   ```cmd
   npm ci
   node scripts/generate-readme.mjs
   ```
4. 提交两个文件（新 YAML + 重新生成的 README）→ 向 upstream 提 PR
5. 合并后 dsh-market 自动收录（约一天），DSH 用户 设置→Plugin Market 可搜到 `skill-dag-dsh`

---

## 5. 内容铺开（docs/promotion-drafts.md 三件套已就绪）

| 时间 | 动作 | 材料 |
|---|---|---|
| Day 0 | GitHub push + topics + npm 双包 | 第 2、3 步 |
| Day 1 | awesome PR（仓库满 1 天） | 第 4 步 |
| Day 1-3 | 掘金技术文《复刻腾讯 GraSP：…4 个坑》 | promotion-drafts.md §1 |
| Day 1-3 | Show HN + Reddit 两帖 | promotion-drafts.md §2、§3 |
| Week 2 | 知乎/V2EX 提问式帖 + DSH 社区 | 同上，改语气 |
| Week 2-3 | 复盘：stars / downloads / PR 合并 | 对照验收指标 |

验收（发布 2 周）：**stars > 50、npm downloads > 200、awesome PR 合并**。

---

## 常见问题

- **`npm install` 卡住/报网络错**：换镜像 `npm config set registry https://registry.npmmirror.com`，装完改回。
- **push 报错 non-fast-forward**：`git pull --rebase origin main` 再 push。
- **npm publish 报 403/402**：没登录或包名冲突，`npm whoami` 检查登录状态。
- **想改 README 里 demo 图**：`docs/demo-dag.svg` 用浏览器打开截图即可替换。
