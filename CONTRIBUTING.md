# 贡献指南

## 流程

- `master` 受分支保护：所有改动（包括维护者的）都必须经 Pull Request 合入，合并方式仅为 squash merge。
- 提交 PR 前请通过 `node scripts/test_all.cjs` 与 `node scripts/audit_repo.cjs`。

## Developer Certificate of Origin（DCO）

本项目采用 [DCO 1.1](https://developercertificate.org/) 作为贡献凭证。每个提交必须包含 `Signed-off-by` 行（`git commit -s` 会自动添加）：

```
Signed-off-by: Your Name <you@example.com>
```

添加该行即表示你确认：

1. 该提交为你的原创作品，或你有权依据本仓库的 MIT 许可证提交其中的全部内容；
2. 提交中不包含你无权授权的第三方代码、文本、图像或其他资源（例如取自商业游戏、闭源软件或第三方模组的逐字内容）；
3. 你理解该提交将按本仓库许可证公开分发。

## 内容纪律

- 不提交任何商业游戏或第三方模组的可执行文件、媒体资源、脚本文件或逐字摘录。
- 接口签名、版本指纹、参数数值等事实性数据可以记录，并须按 `AGENTS.md` 的数据政策标注来源类别（官方数据 / 公开估计【假设】/ 项目设定）。
