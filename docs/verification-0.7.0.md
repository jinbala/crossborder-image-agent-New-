# 0.7.0 本机验收记录

日期：2026-10-20。范围为当前 Windows 开发机，不是干净机或官方平台验收。

| 验证 | 结果 |
| --- | --- |
| 后端完整 npm.cmd test | 515/515，独立临时数据根目录 |
| 前端 npm.cmd test | 174/174 |
| 桌面 npm.cmd test | 8/8 |
| 采集、扩展状态机、图包/API 专项 | 30/30 |
| 100 商品 XLSX 组合 | 50 过滤，49 成功，1 失败；损坏恢复不重复下载；ZIP 与 manifest 一致 |
| 0.7.0 生产前端构建 | 通过，路由懒加载；主包仍有 500KB 告警 |
| 安装版与便携版 | 已构建，约 119MB/个，无代码签名证书 |
| 最终便携 EXE | packaged=true，39/39，退出码正常 |
| 包资源 | 5,916 项，禁入数据 0、缺失 0、关键源文件散列不一致 0，含 SQLite/Sharp 原生模块 |
| 扩展 | 0.5.1，自动复制到稳定的本地可加载目录，不依赖 app.asar/临时解压位置 |
| npm 审计 | backend/frontend 全依赖 0；desktop 生产依赖 0，构建链 8 moderate 未清除 |
| rembg | 依赖已安装且 pip check 通过；未下载权重，未确认模型许可，未实际推理 |
| git diff --check | 通过；有 LF→CRLF 提示，不是空白错误 |

可复核报告：desktop/.smoke-data/portable-0.7.0-stable-extension/smoke-report.json。测试内容包括主会话与扩展权限边界、实际窗口与生产页面、SQLite/Sharp/ZIP、单实例、重启与旧端口停止、稳定扩展目录、支持包、POD、备份、商店模拟幂等、Web 登录/退出、Windows 安全存储设备同步及撤销。

Temu 用户反馈仅证实 Edge 当前页手动清单 1 商品成功/0 失败；尚未收到图片回传和验证码恢复结果。状态机测试使用本地 Chrome API 夹具，不访问真实浏览器/账号/站点，不能作为实站成功证据。

完整 68 项实现与剩余缺口：[implementation-progress.md](./implementation-progress.md)。历史业务对象隔离、全量双语、大负载响应、官方平台/支付、实际更新回退、干净机安装卸载和真实图片质量仍未关闭。没有自动发布、线上改价、验证码绕过、模型权重下载、远端部署或 Git 推送。
