#!/usr/bin/env bash
# 在 K1 上部署 open-kairos 到测试或正式环境。
#
# 用法: scripts/deploy-k1.sh test|prod
#   test  把当前仓库目录（开发 clone）同步到 ~/personal/open-kairos-test 并重启测试环境
#         （端口 4318，tmux 会话 kairos-test，数据目录 ~/.kairos-test）。
#   prod  把 ~/personal/open-kairos 对齐到 origin/main 并重启正式环境
#         （端口 4317，tmux 会话 kairos，数据目录 ~/.kairos）。
#         健康检查失败时回滚到部署前的提交；若本次部署执行过数据库迁移，
#         同时恢复迁移前备份。
#
# 两个目标都会在启动前预检数据库版本，存在未迁移版本时执行显式迁移（自动备份）。
# .env、数据目录与 start-k1.sh 为各环境本地文件，部署过程不会修改。
set -euo pipefail

TARGET=${1:-}
case $TARGET in
  test)
    DEPLOY_DIR=$HOME/personal/open-kairos-test
    TMUX_SESSION=kairos-test
    PORT=4318
    ;;
  prod)
    DEPLOY_DIR=$HOME/personal/open-kairos
    TMUX_SESSION=kairos
    PORT=4317
    ;;
  *)
    echo "usage: $0 test|prod" >&2
    exit 64
    ;;
esac

export PATH="$HOME/opt/node-v26.4.0-linux-x64/bin:$HOME/.gyro/bin:$PATH"

log() { printf 'deploy-k1[%s]: %s\n' "$TARGET" "$*"; }
health() { curl --fail --silent --show-error --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/"; }
stop_service() { tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true; }
start_service() { tmux new-session -d -s "$TMUX_SESSION" "$DEPLOY_DIR/start-k1.sh"; }

build() {
  cd "$DEPLOY_DIR"
  pnpm install --frozen-lockfile
  pnpm build
}

MIGRATION_BACKUP=''
migrate_if_needed() {
  local data_dir=$1
  local backup_dir=$2
  local check
  check=$(node apps/server/dist/migrate.js --check --data-dir "$data_dir" --backup-dir "$backup_dir")
  [[ $check == *'"status":"migration_required"'* ]] || return 0
  log "数据库存在未迁移版本，执行显式迁移"
  local result
  result=$(node apps/server/dist/migrate.js --data-dir "$data_dir" --backup-dir "$backup_dir")
  MIGRATION_BACKUP=$(printf '%s' "$result" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{process.stdout.write(JSON.parse(s).backupPath??'')}catch{process.stdout.write('')}})")
  log "迁移完成，备份: ${MIGRATION_BACKUP:-未知}"
}

PREVIOUS=''
DATA_DIR=''

if [[ $TARGET == test ]]; then
  SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  [[ $SRC_DIR != "$DEPLOY_DIR" ]] || {
    echo "请在开发 clone 中运行本脚本，不要在测试部署目录内运行。" >&2
    exit 64
  }
  log "同步 $SRC_DIR -> $DEPLOY_DIR"
  mkdir -p "$DEPLOY_DIR"
  rsync -az --delete \
    --exclude '.git' --exclude '.env' --exclude 'node_modules' --exclude 'dist' \
    --exclude 'data' --exclude '.kairos' --exclude '*.log' --exclude 'start-k1.sh' \
    "$SRC_DIR/" "$DEPLOY_DIR/"
else
  PREVIOUS=$(git -C "$DEPLOY_DIR" rev-parse HEAD)
  log "对齐 $DEPLOY_DIR 到 origin/main（当前 ${PREVIOUS:0:8}）"
  git -C "$DEPLOY_DIR" fetch origin
  git -C "$DEPLOY_DIR" reset --hard origin/main
fi

log "安装依赖并构建"
build

DATA_DIR=$(grep -E '^KAIROS_DATA_DIR=' "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
DATA_DIR=${DATA_DIR:-$HOME/.kairos}

log "停止 $TMUX_SESSION"
stop_service
sleep 1
cd "$DEPLOY_DIR"
migrate_if_needed "$DATA_DIR" "$HOME/.kairos-backups/$TARGET"

log "启动 $TMUX_SESSION（端口 $PORT）"
start_service
for _ in $(seq 1 20); do
  if health 2>/dev/null; then
    log "健康检查通过: http://127.0.0.1:$PORT/"
    exit 0
  fi
  sleep 1
done

if [[ $TARGET == prod ]]; then
  log "健康检查失败，回滚到 ${PREVIOUS:0:8}"
  stop_service
  sleep 1
  if [[ -n $MIGRATION_BACKUP && -f $MIGRATION_BACKUP ]]; then
    log "恢复数据库备份 $MIGRATION_BACKUP"
    cp -a "$MIGRATION_BACKUP" "$DATA_DIR/kairos.sqlite"
    rm -f "$DATA_DIR/kairos.sqlite-wal" "$DATA_DIR/kairos.sqlite-shm"
  fi
  git -C "$DEPLOY_DIR" reset --hard "$PREVIOUS"
  build
  start_service
  if health 2>/dev/null; then
    log "回滚完成，服务已恢复"
  else
    log "回滚后健康检查仍失败，需要人工处理" >&2
  fi
  exit 1
fi
log "健康检查失败，请查看 /tmp/kairos-test.log" >&2
exit 1
