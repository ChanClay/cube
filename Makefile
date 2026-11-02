# Cube —— 常用命令
# 用法：make          查看全部命令
#       make dev      启动开发服务器

PORT ?= 4500
NPM  ?= npm

.DEFAULT_GOAL := help

.PHONY: help install env setup dev proxy build start typecheck check stop restart db migrate logs clean clean-data distclean

help: ## 显示可用命令
	@echo "Cube"
	@echo "-----------------------------------------------"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sed -E 's/:.*## /\t/' \
		| sort \
		| awk -F'\t' '{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo "-----------------------------------------------"
	@echo "服务地址：http://localhost:$(PORT)"

install: ## 安装依赖
	$(NPM) install

env: ## 从 .env.example 生成 .env.local（已存在则跳过）
	@if [ -f .env.local ]; then \
		echo ".env.local 已存在，跳过"; \
	else \
		cp .env.example .env.local; \
		echo "已创建 .env.local，请填入 LLM_API_KEY / VIDEO_API_KEY"; \
	fi

setup: install env ## 一键初始化：装依赖 + 准备 env 文件
	@echo "初始化完成，运行 make dev 启动"

dev: ## 启动开发服务器（默认 4500）
	@echo "→ http://localhost:$(PORT)"
	@npx next dev -p $(PORT)

proxy: ## 起公网隧道（npx tunnelmole 4500）
	@echo "→ 隧道指向 http://localhost:$(PORT)"
	@npx --yes tunnelmole $(PORT)

build: ## 生产构建
	$(NPM) run build

start: ## 以生产模式启动（需先 make build）
	@echo "→ http://localhost:$(PORT)"
	@npx next start -p $(PORT)

typecheck: ## TypeScript 类型检查
	@npx tsc --noEmit && echo "类型检查通过"

check: typecheck build ## 类型检查 + 生产构建

stop: ## 停止占用端口的进程
	@PIDS=$$(lsof -ti:$(PORT) 2>/dev/null); \
	if [ -n "$$PIDS" ]; then kill $$PIDS; echo "已停止进程：$$PIDS"; else echo "端口 $(PORT) 上没有运行中的进程"; fi

restart: stop ## 重启开发服务器
	@sleep 1
	@$(MAKE) dev

logs: ## 查看调用日志（video / agent，最近 50 条）
	@if ls .data/logs/*.log >/dev/null 2>&1; then tail -n 50 .data/logs/*.log; else echo "还没有日志：.data/logs/ 下没有 *.log（尚未发生错误或降级）"; fi

db: ## 查看 MySQL 表统计
	@node scripts/db-stats.mjs

migrate: ## 把旧 SQLite 数据迁移到 MySQL
	@node scripts/migrate-sqlite-to-mysql.mjs

clean: ## 清理构建产物
	rm -rf .next next-env.d.ts
	@echo "已清理 .next"

clean-data: ## 清理导出成片与临时文件（.data，不影响 MySQL）
	rm -rf .data
	@echo "已清理 .data（数据库数据在 MySQL，未受影响）"

distclean: clean clean-data ## 彻底清理：构建产物 + 数据 + 依赖
	rm -rf node_modules
	@echo "已清理 node_modules，重新运行 make setup"
