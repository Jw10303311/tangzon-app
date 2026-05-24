# Tangzon 产品管理

亚马逊产品管理桌面工具。

## 功能

- 产品库管理（4 大类 29 子类）
- 关注 / 淘汰 / 活动池
- 三级细分类目
- 自动抓取产品主图
- 数据自动保存（IndexedDB）
- 系统托盘 / 开机自启 / 桌面通知
- 自动更新

## 开发

```bash
npm install
npm start         # 本地运行
npm run build     # 打包
```

## 自动发布

修改 `package.json` 的 `version` 字段并推送到 `main` 分支后，
GitHub Actions 会自动打包并发布到 Releases。
已安装的应用会自动检测并提示更新。
