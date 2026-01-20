FROM node:alpine

# 安装必要工具
RUN apk add --no-cache curl unzip

WORKDIR /app

# 先复制 package.json，利用 Docker 缓存加速构建
COPY package.json .

# [...](asc_slot://start-slot-7)安装依赖 (这步会安装 http-proxy)
RUN npm install

# 下载 Xray 核心 (以 Linux 64位为例)
RUN wget -q https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip && \
    unzip -q Xray-linux-64.zip && \
    mv xray /usr/bin/xray && \
    chmod +x /usr/bin/xray && \
    rm -f Xray-linux-64.zip *.dat *.json

# [...](asc_slot://start-slot-9)复制其余代码
COPY . .

# 启动
CMD ["npm", "start"]
