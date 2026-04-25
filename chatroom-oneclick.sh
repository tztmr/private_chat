#!/usr/bin/env bash
# 使用方式 chmod +x ./chatroom-oneclick.sh && bash ./chatroom-oneclick.sh
set -euo pipefail

if [[ -t 1 ]]; then
  R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[1;33m'; B=$'\033[0;34m'; C=$'\033[0;36m'; NC=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; C=''; NC=''
fi

info() { printf "${B}[INFO]${NC} %s\n" "$1"; }
warn() { printf "${Y}[WARN]${NC} %s\n" "$1"; }
error() { printf "${R}[ERROR]${NC} %s\n" "$1" >&2; }
ok() { printf "${G}[OK]${NC} %s\n" "$1"; }

APP_NAME="private-chat"
DEFAULT_REPO_URL="https://github.com/tztmr/private_chat.git"
DEFAULT_BRANCH="main"
STATE_DIR="${HOME}/.private-chat-oneclick"
STATE_FILE="${STATE_DIR}/state.env"
DOCKER_COMPOSE_CMD=()

trim() {
  local v="${1:-}"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then "$@"; return $?; fi
  if command_exists sudo; then sudo "$@"; return $?; fi
  return 1
}

ensure_root_capability() {
  if [[ "$(id -u)" -eq 0 ]]; then return 0; fi
  if ! command_exists sudo; then
    error "请使用 root 运行，或先安装 sudo"
    exit 1
  fi
  if ! sudo -n true 2>/dev/null; then
    error "当前账号需要 sudo 免密或交互授权后再运行"
    exit 1
  fi
}

prompt_default() {
  local prompt="$1" def="${2:-}" val=""
  if [[ -n "$def" ]]; then
    printf '%s [%s]: ' "$prompt" "$def" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  read -r val
  val="$(trim "$val")"
  [[ -z "$val" ]] && val="$def"
  printf '%s' "$val"
}

ask_yes_no() {
  local prompt="$1" def="${2:-y}" ans="" hint="[Y/n]"
  [[ "$def" == "n" ]] && hint="[y/N]"
  while true; do
    printf '%s %s: ' "$prompt" "$hint" >&2
    read -r ans
    ans="$(trim "$ans")"
    [[ -z "$ans" ]] && ans="$def"
    ans="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
    case "$ans" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) warn "请输入 y 或 n" ;;
    esac
  done
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
}

save_state() {
  local install_dir="$1" repo_url="$2" branch="$3" host_port="$4" domain="${5:-}"
  ensure_state_dir
  cat > "$STATE_FILE" <<EOF
INSTALL_DIR='${install_dir}'
REPO_URL='${repo_url}'
BRANCH='${branch}'
HOST_PORT='${host_port}'
DOMAIN='${domain}'
EOF
  chmod 600 "$STATE_FILE" 2>/dev/null || true
}

load_state() {
  [[ -f "$STATE_FILE" ]] || return 1
  set +u
  source "$STATE_FILE"
  set -u
  [[ -n "${INSTALL_DIR:-}" && -n "${REPO_URL:-}" && -n "${BRANCH:-}" && -n "${HOST_PORT:-}" ]]
}

validate_port() {
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  (( "$1" >= 1 && "$1" <= 65535 ))
}

pick_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD=(docker compose)
  elif command_exists docker-compose; then
    DOCKER_COMPOSE_CMD=(docker-compose)
  else
    error "未找到 docker compose"
    return 1
  fi
}

install_git_if_needed() {
  command_exists git && return 0
  info "检测到未安装 Git，开始自动安装"
  if command_exists apt-get; then
    run_root apt-get update -y -qq
    run_root apt-get install -y -qq git
  elif command_exists yum; then
    run_root yum install -y -q git
  elif command_exists dnf; then
    run_root dnf install -y -q git
  else
    error "不支持的系统包管理器，请手动安装 Git"
    return 1
  fi
  ok "Git 安装完成"
}

install_docker_if_needed() {
  if command_exists docker; then
    pick_compose_cmd
    run_root systemctl enable docker 2>/dev/null || true
    run_root systemctl start docker 2>/dev/null || true
    return 0
  fi

  info "检测到未安装 Docker，开始自动安装"
  if command_exists apt-get; then
    run_root apt-get update -y -qq
    run_root apt-get install -y -qq ca-certificates curl gnupg lsb-release
    curl -fsSL https://get.docker.com | run_root bash
  elif command_exists yum; then
    run_root yum install -y -q yum-utils
    run_root yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    run_root yum install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
  elif command_exists dnf; then
    run_root dnf -y -q install dnf-plugins-core
    run_root dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    run_root dnf -y -q install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  else
    error "不支持的系统包管理器，请手动安装 Docker"
    return 1
  fi

  run_root systemctl enable docker
  run_root systemctl start docker
  pick_compose_cmd
  ok "Docker 安装完成"
}

allow_firewall_port() {
  local port="$1"
  if command_exists ufw; then
    if ufw status 2>/dev/null | grep -q "Status: active"; then
      run_root ufw allow "${port}/tcp" >/dev/null 2>&1 || true
      ok "UFW 已放行 ${port}/tcp"
    fi
  fi
  if command_exists firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    run_root firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
    run_root firewall-cmd --reload >/dev/null 2>&1 || true
    ok "firewalld 已放行 ${port}/tcp"
  fi
}

clone_or_update_repo() {
  local install_dir="$1" repo_url="$2" branch="$3"
  if [[ -d "${install_dir}/.git" ]]; then
    info "检测到已有代码，开始更新"
    git -C "$install_dir" fetch origin "$branch"
    git -C "$install_dir" checkout "$branch"
    git -C "$install_dir" pull --ff-only origin "$branch"
  else
    run_root mkdir -p "$(dirname "$install_dir")"
    git clone --branch "$branch" "$repo_url" "$install_dir"
  fi
}

write_compose_file() {
  local install_dir="$1" host_port="$2"
  cat > "${install_dir}/docker-compose.yml" <<EOF
services:
  private-chat:
    build: .
    container_name: ${APP_NAME}
    restart: unless-stopped
    environment:
      PORT: 3000
    ports:
      - "${host_port}:3000"
EOF
}

install_nginx_if_needed() {
  command_exists nginx && return 0
  info "检测到未安装 Nginx，开始自动安装"
  if command_exists apt-get; then
    run_root apt-get update -y -qq
    run_root apt-get install -y -qq nginx
  elif command_exists dnf; then
    run_root dnf install -y -q nginx
  elif command_exists yum; then
    run_root yum install -y -q nginx
  else
    error "无法自动安装 Nginx，请手动安装后重试"
    return 1
  fi
  run_root systemctl enable nginx
  run_root systemctl start nginx
  ok "Nginx 安装完成"
}

install_certbot_if_needed() {
  command_exists certbot && return 0
  if command_exists apt-get; then
    run_root apt-get update -y -qq
    run_root apt-get install -y -qq certbot python3-certbot-nginx
  elif command_exists dnf; then
    run_root dnf install -y -q certbot python3-certbot-nginx || run_root dnf install -y -q certbot-nginx
  elif command_exists yum; then
    run_root yum install -y -q certbot python3-certbot-nginx || run_root yum install -y -q certbot-nginx
  else
    error "无法自动安装 certbot，请手动安装后重试"
    return 1
  fi
}

nginx_conf_dir() {
  if [[ -d /etc/nginx/conf.d ]]; then
    printf '/etc/nginx/conf.d'
  else
    printf '/etc/nginx/sites-available'
  fi
}

setup_nginx_ssl() {
  load_state || { error "未找到部署记录，请先执行部署"; return 1; }
  ensure_root_capability
  install_nginx_if_needed
  install_certbot_if_needed

  local domain email conf_dir conf_file
  domain="$(prompt_default "绑定域名（如 chat.example.com）" "${DOMAIN:-}")"
  [[ -z "$domain" ]] && { error "域名不能为空"; return 1; }
  email="$(prompt_default "证书邮箱" "admin@${domain}")"
  conf_dir="$(nginx_conf_dir)"
  conf_file="${conf_dir}/${domain}.conf"

  run_root mkdir -p "$conf_dir"
  run_root bash -c "cat > '${conf_file}' <<EOF
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${HOST_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF"

  if [[ -d /etc/nginx/sites-enabled ]]; then
    run_root ln -sf "${conf_file}" "/etc/nginx/sites-enabled/${domain}.conf"
  fi

  allow_firewall_port 80
  allow_firewall_port 443
  run_root nginx -t
  run_root systemctl reload nginx 2>/dev/null || run_root nginx -s reload
  run_root certbot --nginx -d "$domain" --redirect -m "$email" --agree-tos --non-interactive
  save_state "$INSTALL_DIR" "$REPO_URL" "$BRANCH" "$HOST_PORT" "$domain"
  ok "Nginx + HTTPS/WSS 已配置完成"
  echo "访问地址: https://${domain}"
}

deploy() {
  ensure_root_capability
  install_git_if_needed
  install_docker_if_needed

  local install_dir repo_url branch host_port
  install_dir="$(prompt_default "部署目录" "/opt/private-chat")"
  repo_url="$(prompt_default "Git 仓库地址" "$DEFAULT_REPO_URL")"
  branch="$(prompt_default "分支名" "$DEFAULT_BRANCH")"
  host_port="$(prompt_default "对外端口" "3000")"

  validate_port "$host_port" || { error "端口无效: $host_port"; return 1; }

  clone_or_update_repo "$install_dir" "$repo_url" "$branch"
  write_compose_file "$install_dir" "$host_port"
  allow_firewall_port "$host_port"

  info "开始构建并启动聊天室"
  (
    cd "$install_dir"
    "${DOCKER_COMPOSE_CMD[@]}" up -d --build
  )

  save_state "$install_dir" "$repo_url" "$branch" "$host_port"

  local server_ip
  server_ip="$(curl -s --connect-timeout 5 ifconfig.me 2>/dev/null || true)"
  [[ -z "$server_ip" ]] && server_ip="服务器IP"

  echo
  ok "匿名聊天室部署完成"
  echo "访问地址: http://${server_ip}:${host_port}"
  echo "本机地址: http://127.0.0.1:${host_port}"
  echo
}

status_app() {
  load_state || { error "未找到部署记录，请先执行部署"; return 1; }
  pick_compose_cmd
  (cd "$INSTALL_DIR" && "${DOCKER_COMPOSE_CMD[@]}" ps)
}

logs_app() {
  load_state || { error "未找到部署记录，请先执行部署"; return 1; }
  pick_compose_cmd
  (cd "$INSTALL_DIR" && "${DOCKER_COMPOSE_CMD[@]}" logs -f --tail 100)
}

restart_app() {
  load_state || { error "未找到部署记录，请先执行部署"; return 1; }
  pick_compose_cmd
  (cd "$INSTALL_DIR" && "${DOCKER_COMPOSE_CMD[@]}" restart)
  ok "服务已重启"
}

update_app() {
  load_state || { error "未找到部署记录，请先执行部署"; return 1; }
  ensure_root_capability
  install_git_if_needed
  pick_compose_cmd
  clone_or_update_repo "$INSTALL_DIR" "$REPO_URL" "$BRANCH"
  write_compose_file "$INSTALL_DIR" "$HOST_PORT"
  (cd "$INSTALL_DIR" && "${DOCKER_COMPOSE_CMD[@]}" up -d --build)
  ok "代码更新并重建完成"
}

uninstall_app() {
  load_state || { error "未找到部署记录，请先执行部署"; return 1; }
  pick_compose_cmd
  warn "将停止并删除容器，默认保留目录 ${INSTALL_DIR}"
  if ask_yes_no "确认继续卸载" "n"; then
    (cd "$INSTALL_DIR" && "${DOCKER_COMPOSE_CMD[@]}" down)
    if ask_yes_no "是否同时删除部署目录（不可恢复）" "n"; then
      run_root rm -rf "$INSTALL_DIR"
      ok "部署目录已删除"
    fi
    ok "卸载完成"
  fi
}

print_menu() {
  echo
  echo "=========== 匿名聊天室一键脚本 ==========="
  echo "1) 一键部署（Docker）"
  echo "2) 查看状态"
  echo "3) 查看日志"
  echo "4) 重启服务"
  echo "5) 更新代码并重建"
  echo "6) Nginx + HTTPS/WSS"
  echo "7) 卸载"
  echo "0) 退出"
  echo "=========================================="
}

main() {
  while true; do
    print_menu
    printf '请选择 [0-7]: ' >&2
    read -r choice
    choice="$(trim "${choice}")"
    case "$choice" in
      1) deploy ;;
      2) status_app ;;
      3) logs_app ;;
      4) restart_app ;;
      5) update_app ;;
      6) setup_nginx_ssl ;;
      7) uninstall_app ;;
      0) exit 0 ;;
      *) warn "无效选项" ;;
    esac
  done
}

main "$@"
