from pathlib import Path
import os
import secrets
import subprocess
import grp

root = Path('/opt/wechat-bot')
credentials = root / 'management-login.txt'
authfile = Path('/etc/nginx/wechat-manage.htpasswd')
if not credentials.exists():
    password = secrets.token_urlsafe(24)
    hashed = subprocess.run(['openssl', 'passwd', '-6', '-stdin'], input=password + '\n', text=True, capture_output=True, check=True).stdout.strip()
    credentials.write_text('地址：https://chat-manage.sharex.team\n用户名：botadmin\n密码：' + password + '\n')
    credentials.chmod(0o600)
    authfile.write_text('botadmin:' + hashed + '\n')
    authfile.chmod(0o640)
    os.chown(authfile, 0, grp.getgrnam('nginx').gr_gid)

vnc_script = Path('/opt/wechat-bot/bowxt-main/scripts/bowxt-start-web')
backup = root / 'bowxt-start-web.upstream'
if not backup.exists():
    backup.write_bytes(vnc_script.read_bytes())
text = backup.read_text().replace('exec /opt/bowxt-venv/bin/bowxt serve', 'exec /opt/bowxt-venv/bin/python /usr/local/bin/bowxt-test-group-web.py')
vnc_script.write_text(text)
