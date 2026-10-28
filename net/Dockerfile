# 使用官方 Deno 镜像
FROM denoland/deno:alpine

# 设置工作目录
WORKDIR /app

# 把当前目录的代码复制进去
COPY . .

# 暴露 8000 端口
EXPOSE 8000

# 启动命令
CMD ["run", "--allow-net", "main.ts"]