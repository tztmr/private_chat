#!/usr/bin/env bash
# 使用方式：chmod +x ./chatroom-oneclick.sh && bash ./chatroom-oneclick.sh
set -euo pipefail

if [[ -t 1 ]]; then
  R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[1;33m'; B=$'\033[0;34m'; NC=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; NC=''
fi

info() { printf "${B}[INFO]${NC} %s\n" "$1"; }
warn() { printf "${Y}[WARN]${NC} %s\n" "$1"; }
error() { printf "${R}[ERROR]${NC} %s\n" "$1" >&2; }
ok() { printf "${G}[OK]${NC} %s\n" "$1"; }

APP_SLUG="anonymous-chatroom"
DEFAULT_REPO_URL="https://github.com/tztmr/private_chat.git"
DEFAULT_BRANCH="main"
DEFAULT_INSTALL_DIR="/opt/anonymous-chatroom"
DEFAULT_CONTAINER_NAME="anonymous-chatroom"
DEFAULT_BIND_PORT="3001"
STATE_DIR="${HOME}/.${APP_SLUG}-deploy"
STATE_FILE="${STATE_DIR}/state.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SCRIPT_DIR}"
DOCKER_COMPOSE_CMD=()

trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return $?
  fi
  if command_exists sudo; then
    sudo "$@"
    return $?
  fi
  return 1
}

ensure_root_capability() {
  if [[ "$(id -u)" -eq 0 ]]; then
    return 0
  fi
  if ! command_exists sudo; then
    error "需要 root 或 sudo 权限"
    exit 1
  fi
  if ! sudo -n true 2>/dev/null; then
    error "当前账号需要先具备 sudo 授权"
    exit 1
  fi
}

prompt_default() {
  local prompt="$1" default_value="${2:-}" answer=""
  if [[ -n "$default_value" ]]; then
    printf '%s [%s]: ' "$prompt" "$default_value" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  read -r answer
  answer="$(trim "$answer")"
  [[ -z "$answer" ]] && answer="$default_value"
  printf '%s' "$answer"
}

ask_yes_no() {
  local prompt="$1" default_value="${2:-y}" answer="" hint="[Y/n]"
  [[ "$default_value" == "n" ]] && hint="[y/N]"
  while true; do
    printf '%s %s: ' "$prompt" "$hint" >&2
    read -r answer
    answer="$(trim "$answer")"
    [[ -z "$answer" ]] && answer="$default_value"
    answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    case "$answer" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) warn "请输入 y 或 n" ;;
    esac
  done
}

validate_port() {
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  (( "$1" >= 1 && "$1" <= 65535 ))
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
}

save_state() {
  ensure_state_dir
  {
    printf 'PROJECT_DIR=%q\n' "$PROJECT_DIR"
    printf 'REPO_URL=%q\n' "$REPO_URL"
    printf 'BRANCH=%q\n' "$BRANCH"
    printf 'APP_BIND_PORT=%q\n' "$APP_BIND_PORT"
    printf 'CONTAINER_NAME=%q\n' "$CONTAINER_NAME"
    printf 'ROOM_ACCESS_PASSWORD=%q\n' "$ROOM_ACCESS_PASSWORD"
    printf 'DOMAIN=%q\n' "${DOMAIN:-}"
    printf 'EMAIL=%q\n' "${EMAIL:-}"
  } > "$STATE_FILE"
  chmod 600 "$STATE_FILE" 2>/dev/null || true
}

load_state() {
  [[ -f "$STATE_FILE" ]] || return 1
  set +u
  source "$STATE_FILE"
  set -u
  [[ -n "${PROJECT_DIR:-}" && -n "${REPO_URL:-}" && -n "${BRANCH:-}" && -n "${APP_BIND_PORT:-}" && -n "${CONTAINER_NAME:-}" ]]
}

assert_project_layout() {
  [[ -f "${PROJECT_DIR}/docker-compose.yml" ]] || { error "项目目录缺少 docker-compose.yml: ${PROJECT_DIR}"; return 1; }
  [[ -f "${PROJECT_DIR}/Dockerfile" ]] || { error "项目目录缺少 Dockerfile: ${PROJECT_DIR}"; return 1; }
  [[ -f "${PROJECT_DIR}/package.json" ]] || { error "项目目录缺少 package.json: ${PROJECT_DIR}"; return 1; }
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

docker_ready() {
  if ! command_exists docker; then
    return 1
  fi
  docker info >/dev/null 2>&1 && return 0
  run_root docker info >/dev/null 2>&1
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    run_root docker "$@"
  fi
}

compose_cmd() {
  docker_cmd compose "$@"
}

ensure_compose_available() {
  compose_cmd version >/dev/null 2>&1 && return 0
  if command_exists docker-compose; then
    DOCKER_COMPOSE_CMD=(docker-compose)
    return 0
  fi
  error "未检测到 docker compose，请升级 Docker 到较新版本后重试"
  return 1
}

install_git_if_needed() {
  if command_exists git; then
    return 0
  fi

  ensure_root_capability
  info "检测到未安装 Git，开始自动安装"
  if command_exists apt-get; then
    run_root apt-get update -y -qq
    run_root apt-get install -y -qq git
  elif command_exists dnf; then
    run_root dnf install -y -q git
  elif command_exists yum; then
    run_root yum install -y -q git
  else
    error "不支持的系统包管理器，请手动安装 Git"
    return 1
  fi

  ok "Git 安装完成"
}

install_docker_if_needed() {
  if docker_ready; then
    ensure_compose_available
    run_root systemctl enable docker 2>/dev/null || true
    run_root systemctl start docker 2>/dev/null || true
    return 0
  fi

  ensure_root_capability
  info "检测到未安装 Docker，开始自动安装"
  if command_exists apt-get; then
    run_root apt-get update -y -qq
    run_root apt-get install -y -qq ca-certificates curl gnupg
    curl -fsSL https://get.docker.com | run_root bash
  elif command_exists dnf; then
    run_root dnf -y -q install dnf-plugins-core
    run_root dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    run_root dnf -y -q install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  elif command_exists yum; then
    run_root yum install -y -q yum-utils
    run_root yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    run_root yum install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
  else
    error "不支持的系统包管理器，请手动安装 Docker"
    return 1
  fi

  run_root systemctl enable docker
  run_root systemctl start docker
  ensure_compose_available
  ok "Docker 安装完成"
}

install_nginx_if_needed() {
  if command_exists nginx; then
    return 0
  fi

  ensure_root_capability
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
  if command_exists certbot; then
    return 0
  fi

  ensure_root_capability
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

allow_firewall_port() {
  local port="$1"
  if command_exists ufw && ufw status 2>/dev/null | grep -q "Status: active"; then
    run_root ufw allow "${port}/tcp" >/dev/null 2>&1 || true
  fi
  if command_exists firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    run_root firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
    run_root firewall-cmd --reload >/dev/null 2>&1 || true
  fi
}

port_owner() {
  local port="$1"

  if command_exists lsof; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1; exit}'
    return 0
  fi

  if command_exists ss; then
    ss -ltnp 2>/dev/null | awk -v target=":$port" '$4 ~ target {print $NF; exit}' | sed -E 's/.*"([^"]+)".*/\1/'
    return 0
  fi

  return 0
}

is_port_in_use() {
  [[ -n "$(port_owner "$1")" ]]
}

container_name_in_use() {
  docker ps -a --filter "name=^/${1}$" --format '{{.Names}}' 2>/dev/null | head -n 1
}

sync_project_code() {
  local install_dir="$1" repo_url="$2" branch="$3"

  if [[ -d "${install_dir}/.git" ]]; then
    info "检测到已有代码，开始拉取最新版本"
    git -C "$install_dir" fetch origin "$branch"
    git -C "$install_dir" checkout "$branch"
    git -C "$install_dir" pull --ff-only origin "$branch"
  else
    if [[ -d "$install_dir" ]] && [[ -n "$(ls -A "$install_dir" 2>/dev/null)" ]]; then
      error "安装目录已存在且不是 Git 仓库：${install_dir}"
      error "请换一个空目录，或先清理该目录后重试"
      return 1
    fi

    ensure_root_capability
    run_root mkdir -p "$(dirname "$install_dir")"
    run_root mkdir -p "$install_dir"
    if [[ "$(id -u)" -ne 0 ]]; then
      run_root chown -R "$(id -u):$(id -g)" "$install_dir"
    fi
    info "开始克隆项目代码到 ${install_dir}"
    git clone --branch "$branch" "$repo_url" "$install_dir"
  fi

  PROJECT_DIR="$install_dir"
}

compose_in_project() {
  (
    cd "$PROJECT_DIR"
    export APP_BIND_PORT="$APP_BIND_PORT"
    export CONTAINER_NAME="$CONTAINER_NAME"
    export ROOM_ACCESS_PASSWORD="$ROOM_ACCESS_PASSWORD"
    if [[ "${DOCKER_COMPOSE_CMD[0]:-}" == "docker-compose" ]]; then
      "${DOCKER_COMPOSE_CMD[@]}" "$@"
    else
      compose_cmd "$@"
    fi
  )
}

nginx_conf_dir() {
  if [[ -d /etc/nginx/conf.d ]]; then
    printf '/etc/nginx/conf.d'
  else
    printf '/etc/nginx/sites-available'
  fi
}

write_nginx_http_conf() {
  local conf_file="$1" domain="$2" app_bind_port="$3"
  local tmp_file
  tmp_file="$(mktemp)"

  cat > "$tmp_file" <<EOF
server {
    listen 80;
    server_name ${domain};

    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:${app_bind_port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF

  run_root install -m 0644 "$tmp_file" "$conf_file"
  rm -f "$tmp_file"
}

write_manual_nginx_example() {
  local domain="$1"
  local output_dir="${PROJECT_DIR}/deploy/nginx/generated"
  local output_file="${output_dir}/${domain}.conf"
  mkdir -p "$output_dir"

  cat > "$output_file" <<EOF
server {
    listen 80;
    server_name ${domain};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:${APP_BIND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF

  ok "已生成反向代理参考配置：${output_file}"
}

print_manual_proxy_hint() {
  warn "当前服务器的 80 或 443 已被其他网关占用，脚本不会再抢占这些端口。"
  echo "请把现有网关的域名转发目标指向：127.0.0.1:${APP_BIND_PORT}"
  echo "这样同一台服务器上只保留一个 443 入口，就不会发生 443 冲突。"
  write_manual_nginx_example "$DOMAIN"
}

print_proxy_hint() {
  load_state || { error "请先执行 Docker 部署"; return 1; }
  local server_name="${DOMAIN:-example.com}"

  echo
  info "当前部署不会直接占用宿主机 443 端口"
  echo "如果服务器上已有 Nginx / Caddy / 宝塔 统一处理 HTTPS，可把域名反代到本机 ${APP_BIND_PORT}："
  echo
  cat <<EOF
server {
    listen 443 ssl http2;
    server_name ${server_name};

    location / {
        proxy_pass http://127.0.0.1:${APP_BIND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF
  echo
}

deploy_app() {
  local install_dir

  install_git_if_needed
  install_docker_if_needed
  pick_compose_cmd || ensure_compose_available

  if load_state; then
    install_dir="${PROJECT_DIR:-$DEFAULT_INSTALL_DIR}"
    REPO_URL="${REPO_URL:-$DEFAULT_REPO_URL}"
    BRANCH="${BRANCH:-$DEFAULT_BRANCH}"
    APP_BIND_PORT="${APP_BIND_PORT:-$DEFAULT_BIND_PORT}"
    CONTAINER_NAME="${CONTAINER_NAME:-$DEFAULT_CONTAINER_NAME}"
    ROOM_ACCESS_PASSWORD="${ROOM_ACCESS_PASSWORD:-dx333}"
  else
    install_dir="$DEFAULT_INSTALL_DIR"
    REPO_URL="$DEFAULT_REPO_URL"
    BRANCH="$DEFAULT_BRANCH"
    APP_BIND_PORT="$DEFAULT_BIND_PORT"
    CONTAINER_NAME="$DEFAULT_CONTAINER_NAME"
    ROOM_ACCESS_PASSWORD="dx333"
  fi

  install_dir="$(prompt_default "项目安装目录" "${install_dir}")"
  REPO_URL="$(prompt_default "Git 仓库地址" "${REPO_URL}")"
  BRANCH="$(prompt_default "分支名" "${BRANCH}")"
  [[ -z "$install_dir" ]] && { error "安装目录不能为空"; return 1; }
  [[ -z "$REPO_URL" ]] && { error "Git 仓库地址不能为空"; return 1; }
  [[ -z "$BRANCH" ]] && { error "分支名不能为空"; return 1; }

  sync_project_code "$install_dir" "$REPO_URL" "$BRANCH"
  assert_project_layout

  CONTAINER_NAME="$(prompt_default "容器名称" "${CONTAINER_NAME}")"
  APP_BIND_PORT="$(prompt_default "容器映射到宿主机的本机端口" "${APP_BIND_PORT}")"
  validate_port "$APP_BIND_PORT" || { error "端口无效：$APP_BIND_PORT"; return 1; }

  if is_port_in_use "$APP_BIND_PORT"; then
    local owner existing_container
    owner="$(port_owner "$APP_BIND_PORT")"
    existing_container="$(container_name_in_use "$CONTAINER_NAME")"
    if [[ "$existing_container" != "$CONTAINER_NAME" ]]; then
      error "端口 ${APP_BIND_PORT} 已被占用：${owner:-未知进程}"
      return 1
    fi
    warn "检测到现有容器正在使用端口 ${APP_BIND_PORT}，将执行原地重建。"
  fi

  ROOM_ACCESS_PASSWORD="$(prompt_default "新建房间密码" "${ROOM_ACCESS_PASSWORD}")"
  [[ -z "$ROOM_ACCESS_PASSWORD" ]] && { error "房间密码不能为空"; return 1; }

  info "开始构建并启动 Docker 服务"
  compose_in_project up -d --build
  save_state

  ok "Docker 部署完成"
  echo "项目目录：${PROJECT_DIR}"
  echo "应用当前仅监听宿主机回环地址：127.0.0.1:${APP_BIND_PORT}"
  echo "这一步不会占用 80/443，因此不会和同机其他 HTTPS 站点冲突。"
}

setup_https() {
  load_state || { error "请先执行 Docker 部署"; return 1; }

  DOMAIN="$(prompt_default "绑定域名（如 chat.example.com）" "${DOMAIN:-}")"
  [[ -z "$DOMAIN" ]] && { error "域名不能为空"; return 1; }
  EMAIL="$(prompt_default "证书邮箱" "${EMAIL:-admin@${DOMAIN}}")"

  local owner_80 owner_443
  owner_80="$(port_owner 80)"
  owner_443="$(port_owner 443)"

  if ! command_exists nginx; then
    if [[ -n "$owner_80" || -n "$owner_443" ]]; then
      save_state
      print_manual_proxy_hint
      return 0
    fi
    install_nginx_if_needed
  elif [[ -n "$owner_80" && "$owner_80" != "nginx" ]] || [[ -n "$owner_443" && "$owner_443" != "nginx" ]]; then
    save_state
    print_manual_proxy_hint
    return 0
  else
    run_root systemctl enable nginx 2>/dev/null || true
    run_root systemctl start nginx 2>/dev/null || true
  fi

  install_certbot_if_needed

  local conf_dir conf_file
  conf_dir="$(nginx_conf_dir)"
  conf_file="${conf_dir}/${DOMAIN}.conf"

  run_root mkdir -p "$conf_dir"
  write_nginx_http_conf "$conf_file" "$DOMAIN" "$APP_BIND_PORT"

  if [[ -d /etc/nginx/sites-enabled ]]; then
    run_root ln -sf "$conf_file" "/etc/nginx/sites-enabled/${DOMAIN}.conf"
  fi

  allow_firewall_port 80
  allow_firewall_port 443
  run_root nginx -t
  run_root systemctl reload nginx 2>/dev/null || run_root nginx -s reload
  run_root certbot --nginx -d "$DOMAIN" --redirect -m "$EMAIL" --agree-tos --non-interactive
  save_state

  ok "HTTPS/WSS 已接入共享 Nginx"
  echo "访问地址：https://${DOMAIN}"
  echo "同机多个站点可以继续共用这一套 443 入口，只需各自使用不同域名。"
}

status_app() {
  load_state || { error "请先执行 Docker 部署"; return 1; }
  install_docker_if_needed
  pick_compose_cmd || ensure_compose_available
  echo "项目目录：${PROJECT_DIR}"
  echo "Git 仓库：${REPO_URL}"
  echo "分支：${BRANCH}"
  echo "容器名称：${CONTAINER_NAME}"
  echo "本机端口：127.0.0.1:${APP_BIND_PORT}"
  echo "域名：${DOMAIN:-未配置}"
  echo
  compose_in_project ps
}

logs_app() {
  load_state || { error "请先执行 Docker 部署"; return 1; }
  install_docker_if_needed
  pick_compose_cmd || ensure_compose_available
  compose_in_project logs -f --tail 100
}

restart_app() {
  load_state || { error "请先执行 Docker 部署"; return 1; }
  install_docker_if_needed
  pick_compose_cmd || ensure_compose_available
  compose_in_project restart
  ok "服务已重启"
}

rebuild_app() {
  load_state || { error "请先执行 Docker 部署"; return 1; }
  install_git_if_needed
  install_docker_if_needed
  pick_compose_cmd || ensure_compose_available
  sync_project_code "$PROJECT_DIR" "$REPO_URL" "$BRANCH"
  assert_project_layout
  compose_in_project up -d --build
  save_state
  ok "代码已拉取并重新部署"
}

uninstall_app() {
  load_state || { error "请先执行 Docker 部署"; return 1; }
  install_docker_if_needed
  pick_compose_cmd || ensure_compose_available
  warn "将停止并删除聊天室容器，Nginx 配置不会自动删除。"
  if ask_yes_no "确认继续卸载" "n"; then
    compose_in_project down
    ok "容器已卸载"
  fi
}

print_menu() {
  echo
  echo "============= 匿名聊天室部署脚本 ============="
  echo "1) 自动拉代码 + Docker 部署"
  echo "2) 接入域名 HTTPS/WSS（复用共享 443）"
  echo "3) 查看容器状态"
  echo "4) 查看日志"
  echo "5) 重启服务"
  echo "6) 拉取最新代码并重建"
  echo "7) 输出反代配置示例"
  echo "8) 卸载容器"
  echo "0) 退出"
  echo "=============================================="
}

interactive_main() {
  while true; do
    print_menu
    printf '请选择 [0-8]: ' >&2
    local choice
    read -r choice
    choice="$(trim "$choice")"
    case "$choice" in
      1) deploy_app ;;
      2) setup_https ;;
      3) status_app ;;
      4) logs_app ;;
      5) restart_app ;;
      6) rebuild_app ;;
      7) print_proxy_hint ;;
      8) uninstall_app ;;
      0) exit 0 ;;
      *) warn "无效选项" ;;
    esac
  done
}

main() {
  case "${1:-}" in
    deploy) deploy_app ;;
    https) setup_https ;;
    status) status_app ;;
    logs) logs_app ;;
    restart) restart_app ;;
    rebuild) rebuild_app ;;
    proxy) print_proxy_hint ;;
    uninstall) uninstall_app ;;
    "") interactive_main ;;
    *)
      error "不支持的命令: $1"
      echo "可用命令: deploy | https | status | logs | restart | rebuild | proxy | uninstall"
      exit 1
      ;;
  esac
}

main "$@"
