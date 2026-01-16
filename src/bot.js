import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { createMysticTask, getMysticTask } from './freepik.js';

export function createBot({
  botToken,
  channelUsername,
  webAppUrl,
  freepikApiKey,
  db,
}) {
  const bot = new Telegraf(botToken);

  // ✅ VIP owner bypass
  const OWNER_ID = Number(process.env.OWNER_ID || 0);

  const START_BONUS_CREDITS = Number(process.env.START_BONUS_CREDITS || 2);
  const REFERRAL_BONUS_CREDITS = Number(process.env.REFERRAL_BONUS_CREDITS || 1);

  // Packs Stars -> credits
  const PACKS = [
    { id: 'p10', title: '10 генераций', credits: 10, stars: 49, description: 'Пак на 10 генераций' },
    { id: 'p30', title: '30 генераций', credits: 30, stars: 129, description: 'Пак на 30 генераций' },
    { id: 'p100', title: '100 генераций', credits: 100, stars: 399, description: 'Пак на 100 генераций' },
  ];

  let botUsername = null;
  bot.telegram.getMe().then((me) => {
    botUsername = me?.username || null;
  }).catch(() => {});

  const genState = new Map(); // userId -> { mode: 'await_prompt', aspect_ratio, preset? }

  // ---------- helpers ----------
  function makeRefCode(userId) {
    return Number(userId).toString(36);
  }

  function parseStartParam(text) {
    const m = String(text || '').match(/^\/start(?:\s+(.+))?/);
    const param = (m?.[1] || '').trim();
    return param || null;
  }

  // safer HTML output (avoid Telegram parse errors)
  function esc(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function ensureUser(from, referredBy = null) {
    const existing = db.getUser.get(from.id);

    // IMPORTANT: db.upsertUser должен НЕ сбрасывать credits (мы это уже фиксили)
    if (!existing) {
      db.upsertUser.run(
        from.id,
        from.username || null,
        from.first_name || null,
        from.last_name || null,
        Date.now(),
        START_BONUS_CREDITS,
        referredBy
      );
    } else {
      // обновляем только мета-данные
      db.upsertUser.run(
        from.id,
        from.username || null,
        from.first_name || null,
        from.last_name || null,
        existing.joined_at || Date.now(),
        existing.credits || 0,
        existing.referred_by || null
      );
    }

    return { user: db.getUser.get(from.id), isNew: !existing };
  }

  async function isSubscribed(userId) {
    // ✅ VIP owner bypass
    if (OWNER_ID && Number(userId) === OWNER_ID) return true;

    // getChatMember works reliably only when bot is admin in channel
    const url = `https://api.telegram.org/bot${botToken}/getChatMember`;
    const res = await axios.get(url, {
      params: {
        chat_id: channelUsername, // e.g. '@gurenko_kristina_ai'
        user_id: userId,
      },
      timeout: 15_000,
    });

    const status = res.data?.result?.status;
    return ['member', 'administrator', 'creator'].includes(status);
  }

  function gateKeyboard() {
    const ch = channelUsername.replace('@', '');
    return Markup.inlineKeyboard([
      [Markup.button.url('✅ Подписаться на канал', `https://t.me/${ch}`)],
      [Markup.button.callback('🔄 Проверить подписку', 'check_sub')],
    ]);
  }

  function mainMenuKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🎨 Генерация', 'gen')],
      [Markup.button.callback('📚 Промты', 'prompts')],
      [Markup.button.callback('👤 Профиль', 'profile'), Markup.button.callback('💫 Купить', 'buy')],
      [Markup.button.webApp('🌐 Открыть Mini App', webAppUrl)],
      [Markup.button.callback('🆘 Поддержка', 'help')],
    ]);
  }

  async function showGate(ctx) {
    return ctx.reply(
      `Чтобы пользоваться ботом, подпишись на канал: ${channelUsername}\n\nПосле подписки нажми «Проверить подписку».`,
      gateKeyboard()
    );
  }

  async function showMenu(ctx) {
    return ctx.reply('Готово ✅\n\nВыбирай, что делаем:', mainMenuKeyboard());
  }

  // ---------- /start ----------
  bot.start(async (ctx) => {
    try {
      // referral parse
      const startParam = parseStartParam(ctx.message?.text);
      let referredBy = null;
      let referrerUserId = null;

      if (startParam?.startsWith('ref_')) {
        referredBy = startParam;
        const code = startParam.replace('ref_', '').trim();
        const parsed = parseInt(code, 36);
        if (!Number.isNaN(parsed)) referrerUserId = parsed;
      }

      const { isNew } = ensureUser(ctx.from, referredBy);

      // gate
      const ok = await isSubscribed(ctx.from.id);
      if (!ok) return showGate(ctx);

      // referral bonus (если у тебя в db.js есть эти методы — ок; если нет, просто пропустим)
      if (isNew && referrerUserId && referrerUserId !== ctx.from.id) {
        try {
          if (db.hasReferral && db.insertReferral && db.addCredits) {
            const already = db.hasReferral.get(referrerUserId, ctx.from.id);
            if (!already) {
              db.insertReferral.run(referrerUserId, ctx.from.id, Date.now());
              db.addCredits.run(REFERRAL_BONUS_CREDITS, ctx.from.id);
              db.addCredits.run(REFERRAL_BONUS_CREDITS, referrerUserId);

              bot.telegram.sendMessage(
                referrerUserId,
                `🎁 У тебя новый друг по ссылке! +${REFERRAL_BONUS_CREDITS} генерац(ии) добавлено в профиль.`
              ).catch(() => {});
            }
          }
        } catch {
          // ignore referral system errors
        }
      }

      return showMenu(ctx);
    } catch (e) {
      return ctx.reply(
        'Не смог проверить подписку 🙈\n\nВажно: добавь бота админом в канал, иначе Telegram не даст проверить участников.'
      );
    }
  });

  // ---------- paysupport ----------
  bot.command('paysupport', async (ctx) => {
    return ctx.reply(
      '💬 Поддержка по оплате\n\nЕсли у тебя списались Stars, а генерации не начислились — пришли сюда скрин оплаты и свой @username. Мы разберёмся ✅'
    );
  });

  // ---------- check_sub ----------
  bot.action('check_sub', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const ok = await isSubscribed(ctx.from.id);
      if (!ok) return ctx.reply('Пока не вижу подписку 😌 Подпишись и нажми ещё раз.', gateKeyboard());
      return showMenu(ctx);
    } catch (e) {
      return ctx.reply('Ошибка проверки подписки.\nПроверь, что бот админ в канале и канал указан правильно.');
    }
  });

  // ---------- help ----------
  bot.action('help', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply(
      `🆘 Поддержка\n\n• Генерация работает через Freepik API\n• Новые промты подтягиваются из канала\n\nЕсли что-то не работает — напиши: @gurenko_kristina`
    );
  });

  // ---------- profile ----------
  bot.action('profile', async (ctx) => {
    await ctx.answerCbQuery();

    // gate (owner bypass inside isSubscribed)
    try {
      const ok = await isSubscribed(ctx.from.id);
      if (!ok) return showGate(ctx);
    } catch {
      // ignore
    }

    const { user } = ensureUser(ctx.from);

    const refCode = makeRefCode(ctx.from.id);
    const deepLink = botUsername
      ? `https://t.me/${botUsername}?start=ref_${refCode}`
      : `https://t.me/<YOUR_BOT_USERNAME>?start=ref_${refCode}`;

    const shareBot = `https://t.me/share/url?url=${encodeURIComponent(deepLink)}&text=${encodeURIComponent('Держи бот с промтами и генерацией 🔥')}`;
    const channelLink = `https://t.me/${channelUsername.replace('@', '')}`;
    const shareChannel = `https://t.me/share/url?url=${encodeURIComponent(channelLink)}&text=${encodeURIComponent('Подпишись на канал — там новые промты и гайды 🤍')}`;

    const credits = Number(user?.credits || 0);
    const spentStars = Number(user?.spent_stars || 0);
    const lastResult = user?.last_result ? String(user.last_result) : null;

    // ✅ HTML (без ошибок Markdown)
    let text = '';
    text += `👤 <b>Профиль</b>\n\n`;
    text += `• ID: <code>${esc(user.user_id)}</code>\n`;
    text += `• Username: <b>@${esc(user.username || 'без_ника')}</b>\n`;
    text += `• Генерации: <b>${esc(credits)}</b>\n`;
    text += `• Потрачено Stars: <b>${esc(spentStars)}</b>\n`;

    if (lastResult) {
      text += `\n<b>Последний результат:</b>\n${esc(lastResult)}\n`;
    }

    text += `\n🔗 <b>Твоя ссылка для друзей:</b>\n${esc(deepLink)}`;

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('💫 Купить генерации', 'buy')],
      [Markup.button.url('🔗 Поделиться ботом', shareBot)],
      [Markup.button.url('📣 Поделиться каналом', shareChannel)],
      [Markup.button.webApp('🌐 Открыть Mini App', webAppUrl)],
    ]);

    return ctx.reply(text, { parse_mode: 'HTML', ...kb });
  });

  // ---------- buy ----------
  function buyKeyboard() {
    return Markup.inlineKeyboard([
      ...PACKS.map((p) => [Markup.button.callback(`${p.title} — ${p.stars}⭐️`, `buy_pack:${p.id}`)]),
      [Markup.button.callback('⬅️ Назад', 'back_to_menu')],
    ]);
  }

  bot.action('buy', async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const ok = await isSubscribed(ctx.from.id);
      if (!ok) return showGate(ctx);
    } catch {
      // ignore
    }

    ensureUser(ctx.from);
    return ctx.reply('💫 Покупка генераций за Telegram Stars\n\nВыбери пакет:', buyKeyboard());
  });

  bot.action('back_to_menu', async (ctx) => {
    await ctx.answerCbQuery();
    return showMenu(ctx);
  });

  bot.action(/buy_pack:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const packId = String(ctx.match[1] || '').trim();
    const pack = PACKS.find((p) => p.id === packId);
    if (!pack) return ctx.reply('Пакет не найден 🙈');

    // gate
    try {
      const ok = await isSubscribed(ctx.from.id);
      if (!ok) return showGate(ctx);
    } catch {
      // ignore
    }

    ensureUser(ctx.from);

    const payload = `pack:${pack.id}`;

    // Stars invoice
    await bot.telegram.sendInvoice(ctx.from.id, {
      title: pack.title,
      description: `${pack.description}. Начислим +${pack.credits} генераций.`,
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: pack.title, amount: pack.stars }],
    });
  });

  bot.on('pre_checkout_query', async (ctx) => {
    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch {
      // ignore
    }
  });

  // ---------- payment success ----------
  bot.on('message', async (ctx, next) => {
    const sp = ctx.message?.successful_payment;
    if (sp) {
      try {
        const payload = sp.invoice_payload || '';
        const totalStars = Number(sp.total_amount || 0);
        const chargeId = sp.telegram_payment_charge_id || null;

        const packId = payload.startsWith('pack:') ? payload.replace('pack:', '').trim() : null;
        const pack = PACKS.find((p) => p.id === packId);
        const creditsAdded = pack ? pack.credits : 0;

        ensureUser(ctx.from);

        if (creditsAdded > 0 && db.addCredits) {
          db.addCredits.run(creditsAdded, ctx.from.id);
        }
        if (totalStars > 0 && db.addSpentStars) {
          db.addSpentStars.run(totalStars, ctx.from.id);
        }

        // optional purchases table
        if (db.insertPurchase) {
          db.insertPurchase.run(ctx.from.id, payload, totalStars, creditsAdded, chargeId, Date.now());
        }

        await ctx.reply(
          `✅ Оплата прошла!\nНачислила: +${creditsAdded} генераций\nБаланс обновлён 🔥`,
          mainMenuKeyboard()
        );
      } catch (e) {
        await ctx.reply('Оплата прошла, но я не смогла начислить генерации автоматически 🙈 Напиши /paysupport');
      }
      return;
    }

    return next();
  });

  // ---------- prompts ----------
  bot.action('prompts', async (ctx) => {
    await ctx.answerCbQuery();

    // gate
    try {
      const ok = await isSubscribed(ctx.from.id);
      if (!ok) return showGate(ctx);
    } catch {
      // ignore
    }

    const items = db.listPrompts.all(10);
    if (!items.length) {
      return ctx.reply('Пока нет промтов. Добавь пост в канал и я подхвачу ✅');
    }

    const text = items
      .map((p) => `#${p.id} — ${p.title || 'Промт'}\n${String(p.text)
