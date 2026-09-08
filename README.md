<div align="center">

# Gemini Business Integration Lab

Flask 聊天接口、会话配置与本地进程编排的历史集成实验。

![Flask](https://img.shields.io/badge/Backend-Flask-818cf8?style=flat-square)
![Python](https://img.shields.io/badge/Runtime-Python-5eead4?style=flat-square)
![Scope](https://img.shields.io/badge/Scope-Integration_Lab-fb7185?style=flat-square)

[源码导航](#源码导航) · [开发准备](#开发准备) · [运行注意事项](#运行注意事项) · [凭据与使用范围](#凭据与使用范围)

</div>

这个仓库包含 Flask 页面/API、配置管理、聊天服务和进程管理代码。它不是 Google 官方 SDK 或官方企业版服务，也不因名称包含 business 就具备商业授权或可用性保证。

## 源码导航

| 位置 | 作用 |
| --- | --- |
| [app.py](./app.py) | Flask 应用、页面、配置 API 和服务编排 |
| [services](./services) | 配置存储、聊天与进程管理 |
| [templates](./templates)、[static](./static) | 页面模板与静态资源 |
| [requirements.txt](./requirements.txt) | 固定的 Python 依赖 |
| [Dockerfile](./Dockerfile)、[docker-compose.yml](./docker-compose.yml) | 容器构建与运行配置；执行前逐项审阅 |

`CONFIG_STORE_PATH` 决定配置存储位置；未设置时使用仓库内的 `config_profiles.json`。不要把这个文件视作可随意公开的示例，它可能承载会话信息。

## 开发准备

先建立隔离环境，再安装现有依赖。示例适用于 Linux/macOS/WSL：

```sh
git clone https://github.com/alanbulan/geminibusiness.git
cd geminibusiness
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt 'Flask[async]==3.0.2'
```

`app.py` 使用了异步路由，而当前 requirements 只列出基础 Flask；安装对应版本的 async extra 是运行异步视图的前提之一，不代表所有事件循环和进程逻辑已经核验。版本保持与 requirements 一致，不隐式升级整个依赖栈。

参考：[Flask 异步视图说明](https://flask.palletsprojects.com/en/stable/async-await/)。

## 运行注意事项

当前 `app.py` 的直接启动入口会初始化事件循环与进程管理器，并使用 `debug=True`、`host='0.0.0.0'`，端口取 `PORT`，默认 `5000`。这是源码现状，不是安全生产部署建议。

首次运行必须在受控隔离网络中进行，先审查并关闭调试暴露、确认配置接口鉴权和事件循环生命周期。不要只把启动命令换成 Gunicorn 或 Flask CLI 就认为等价：这样可能绕过 `__main__` 中的初始化逻辑。

容器启动、注册与保活相关脚本可能访问外部服务、创建进程或改变配置；应在阅读代码和确认授权后独立执行。本次文档补齐没有运行这些脚本、验证账号或改变部署。

## 凭据与使用范围

根目录已经跟踪 `.env` 和 `config_profiles.json`，因此不能假定仓库已脱敏。若其中存放过真实会话、密码或密钥，应在服务方撤销或轮换；只增加忽略规则、改 README 或删除当前文件都不能撤销历史暴露。

不要把真实配置、Cookie、访问令牌或未脱敏日志发到公开 Issue。本页不复述任何凭据值，也未验证它们是否真实或仍有效。

仅使用自己拥有或获得明确授权的服务与会话，遵守上游规则。源码中的历史接口、模型映射与会话方式需要重新核验，不能作为当前服务可用性的证明。
