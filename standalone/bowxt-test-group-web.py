"""Run the stock bowxt web server with an explicit monitored-chat boundary."""
import os
import time
from bowxt.cli import main
from bowxt.service import BowxtService
from bowxt.store import SQLiteStore

# Keep the account's actual WeChat nickname recognizable during a bot rename.
names = [name.strip() for name in os.environ.get('BOWXT_MY_NAMES', '').split(',') if name.strip()]
os.environ['BOWXT_MY_NAMES'] = ','.join(dict.fromkeys(['小鲸鱼', *names]))

original_list = SQLiteStore.list_chats
original_poll = BowxtService._poll_chat

def test_group_chats(store, *, enabled_only=False):
    chats = original_list(store, enabled_only=enabled_only)
    return [chat for chat in chats if chat.id == 1] if enabled_only else chats

def poll_test_group(service, client, chat):
    if chat.id != 1:
        raise RuntimeError('Chat is outside the configured test group')
    original_poll(service, client, chat)
    if not service.store.get_chat(chat.id).last_error:
        service._set_status(last_poll_completed_at=time.time())

# The original discovery path adds unread chats and reads them immediately.
# This deployment is authorized for one test group, so disable that path.
BowxtService._drain_unread_chats = lambda self, client, **kwargs: False
BowxtService._poll_chat = poll_test_group
SQLiteStore.list_chats = test_group_chats

raise SystemExit(main([
    'serve', '--host', '0.0.0.0', '--port', '8787',
    '--db', os.environ.get('BOWXT_DB', '/home/wechat/.local/share/bowxt/messages.db'),
    '--poll-gap', '1.5', '--action-delay', '0.12', '--sync-mode', 'paused',
]))
