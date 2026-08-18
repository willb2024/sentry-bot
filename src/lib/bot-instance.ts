// src/lib/bot-instance.ts
import { Telegraf } from 'telegraf';

let _bot: Telegraf | null = null;

export function setBotInstance(bot: Telegraf) {
    _bot = bot;
}

export function getBotInstance(): Telegraf {
    if (!_bot) throw new Error('Bot instance not initialized yet.');
    return _bot;
}