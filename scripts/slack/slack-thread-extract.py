#!/usr/bin/env python3
"""
slack-thread-extract.py — 识别并展开指定 Slack 频道中的当日活跃 thread。

输出: /tmp/slack_threads_data.json
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib import error, parse, request

ENV_FILE = Path.home() / 'Orb/profiles/karry/.env'
OUTPUT_FILE = Path('/tmp/slack_threads_data.json')
CHANNELS = {
    'CXXXXXXXXXX': 'your-channel-name',
    'C0AQ8BTPMH8': 'ymfg',
    'C0AQM943UUR': 'ricoh-leasing',
    'C0AQ6AH0L22': 'idom',
}


def get_slack_token() -> str:
    token = os.environ.get('SLACK_BOT_TOKEN', '').strip()
    if token:
        return token
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding='utf-8').splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            if key.strip() == 'SLACK_BOT_TOKEN':
                token = value.strip().strip('"').strip("'")
                if token:
                    return token
    raise RuntimeError('SLACK_BOT_TOKEN not found in env or ~/Orb/profiles/karry/.env')


def slack_api_call(method: str, **params) -> dict:
    token = get_slack_token()
    body = parse.urlencode({k: str(v) for k, v in params.items()}).encode('utf-8')
    req = request.Request(
        f'https://slack.com/api/{method}',
        data=body,
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        method='POST',
    )
    try:
        with request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except error.HTTPError as exc:
        payload = exc.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'HTTP {exc.code}: {payload[:200]}') from exc
    except error.URLError as exc:
        raise RuntimeError(f'network error: {exc.reason}') from exc

    if not data.get('ok'):
        raise RuntimeError(data.get('error', 'unknown_error'))
    return data


def extract_subject(message: dict) -> str:
    text = (message.get('text') or '').strip()
    if text:
        return text[:100]
    for block in message.get('blocks', []) or []:
        block_text = block.get('text', {})
        if isinstance(block_text, dict):
            candidate = (block_text.get('text') or '').strip()
            if candidate:
                return candidate[:100]
    return '(no text)'


def extract_slack_threads(today: date) -> dict:
    print('[Slack] 采集开始...', flush=True)
    today_start = int(datetime.combine(today, datetime.min.time()).timestamp())
    today_end = int(datetime.combine(today + timedelta(days=1), datetime.min.time()).timestamp())
    all_threads: list[dict] = []

    for channel_id, channel_name in CHANNELS.items():
        print(f'[Slack] 扫描 #{channel_name} (ID={channel_id})...', flush=True)
        try:
            history = slack_api_call('conversations.history', channel=channel_id, limit=50)
        except RuntimeError as exc:
            print(f'[Slack] #{channel_name} 读取失败: {exc}', flush=True)
            continue

        messages = history.get('messages', [])
        print(f'[Slack] #{channel_name}: {len(messages)} 条主消息', flush=True)

        for msg in messages:
            thread_ts = msg.get('thread_ts')
            if not thread_ts:
                continue
            try:
                replies = slack_api_call('conversations.replies', channel=channel_id, ts=thread_ts, limit=100)
            except RuntimeError as exc:
                print(f'[Slack] thread {thread_ts} 读取失败: {exc}', flush=True)
                continue

            thread_messages = replies.get('messages', [])
            today_replies = [
                item for item in thread_messages
                if today_start <= float(item.get('ts', 0)) < today_end
            ]
            if not today_replies:
                continue

            subject = extract_subject(thread_messages[0]) if thread_messages else '(no text)'
            all_threads.append({
                'channel_id': channel_id,
                'channel_name': channel_name,
                'thread_ts': thread_ts,
                'subject': subject,
                'total_replies': max(len(thread_messages) - 1, 0),
                'today_replies': len(today_replies),
                'today_messages': [
                    {
                        'ts': item.get('ts'),
                        'user': item.get('user'),
                        'username': item.get('username') or 'unknown',
                        'text': (item.get('text') or '')[:200],
                        'thread_ts': item.get('thread_ts'),
                    }
                    for item in today_replies
                ],
            })
            print(f'[Slack] thread: {subject[:50]}... → 今日 {len(today_replies)} 条', flush=True)

    print(f'[Slack] 合计 {len(all_threads)} 个活跃 thread', flush=True)
    return {
        'date': today.isoformat(),
        'extracted_at': datetime.now().isoformat(),
        'threads': all_threads,
    }


if __name__ == '__main__':
    target_date = date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else date.today()
    try:
        data = extract_slack_threads(target_date)
    except Exception as exc:
        print(f'[ERROR] {exc}', file=sys.stderr)
        raise SystemExit(1)
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[Slack] {OUTPUT_FILE} 写入完成', flush=True)
