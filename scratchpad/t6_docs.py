import pathlib

ROOT = pathlib.Path(r'C:\Users\Roman Andreevich\Desktop\smth')

def edit(rel, pairs):
    path = ROOT / rel
    raw = path.read_bytes().decode('utf-8')
    crlf = '\r\n' in raw
    text = raw.replace('\r\n', '\n')
    for old, new in pairs:
        assert text.count(old) == 1, (rel, old[:80])
        text = text.replace(old, new)
    if crlf:
        text = text.replace('\n', '\r\n')
    path.write_bytes(text.encode('utf-8'))
    print('edited', rel, 'crlf' if crlf else 'lf')

edit('src/QuotaPanel.tsx', [(
    """Уровень
        определяется по названию модели (файл electron/model-tiers.json), неизвестные модели берутся только из пула.""",
    """Уровень
        модели берётся из замера (аудит моделей), для остальных — по названию (файл electron/model-tiers.json); неизвестные и ненадёжные модели
        берутся только из пула.""",
)])

edit('docs/providers.md', [(
    """Which model may replace which is decided by `electron/model-tiers.json`: ordered patterns on the lowercase model id that
give a tier (3 flagship, 2 strong, 1 light). It follows naming conventions, not measured quality; edit it when a new
model family appears. Doubtful models are placed low, which only makes a replacement rarer, never worse.""",
    """Which model may replace which is decided by `electron/model-tiers.json`: ordered patterns on the lowercase model id that
give a tier (3 flagship, 2 strong, 1 light, 0.5 weak, 0 unknown or unreliable). The first patterns are measured: models
the model audit (`docs/MODEL-AUDIT.md`) placed away from what their names suggest, each with the reason in `measured`
(GPT-6 Luna is strong, not light; Claude Haiku 4.5 and the `haiku` alias are weak; GPT-OSS gave no answer and is taken
only from the pool). The rest follow naming conventions; edit the file when a new model family appears or a new audit
measures one. Doubtful models are placed low, which only makes a replacement rarer, never worse.""",
)])

edit('docs/ARCHITECTURE.md', [(
    """Quality is compared by tier (`model-tiers.json`: 3 flagship, 2 strong, 1 light, 0 unknown) which follows naming conventions, not measurements, and places doubtful models low: a candidate needs the tier of the agent's model (its actual model, else a deliberately high per-provider baseline), one lower if the run allows weaker models, never a light one, and unknown models only from the pool.""",
    """Quality is compared by tier (`model-tiers.json`: 3 flagship, 2 strong, 1 light, 0.5 weak, 0 unknown or unreliable): measured tiers from the model audit (`docs/MODEL-AUDIT.md`) come first, the rest follow naming conventions and place doubtful models low. A candidate needs the tier of the agent's model (its actual model; else, and for a tier-0 model, a deliberately high per-provider baseline), one lower if the run allows weaker models (so a flagship never gets a light one and a strong agent never a weak one), and unknown or unreliable models only from the pool.""",
)])

edit('docs/MODEL-AUDIT.md', [(
    """5. **Ранги моделей по названию** (`electron/model-tiers.json`, для замены при исчерпании квоты) расходятся с
   замером: GPT-6 Luna по названию «лёгкая», а работает на уровне флагманов; Haiku 4.5 заметно слабее остальных
   «лёгких».""",
    """5. **Ранги моделей по названию** (`electron/model-tiers.json`, для замены при исчерпании квоты) расходятся с
   замером: GPT-6 Luna по названию «лёгкая», а работает на уровне флагманов; Haiku 4.5 заметно слабее остальных
   «лёгких». *Исправлено 2026-09-30:* первые правила файла взяты из замера и называют причину. GPT-6 Luna — «сильная»
   (заменяет Sonnet и другие сильные модели, но не флагманов: русский текст у неё слабый). Haiku 4.5 и псевдоним
   `haiku` — новый уровень «слабая»: заменяют только слабые модели или, если разрешены более слабые, лёгкие. GPT-OSS
   120B, который завис и не ответил, берётся только из пула, как неизвестная модель.""",
)])

edit('docs/CHANGELOG.md', [(
    """Изменения в рабочей копии, ещё не закоммиченные. Каждая задача бесконечного улучшения дописывает сюда свою запись.

""",
    """Изменения в рабочей копии, ещё не закоммиченные. Каждая задача бесконечного улучшения дописывает сюда свою запись.

- **Замена при исчерпании квоты учитывает замер моделей.** Раньше уровень модели для автозамены определялся только по названию (`electron/model-tiers.json`). Аудит моделей показал три расхождения. GPT-6 Luna по названию «лёгкая», а набрала 96,9 балла из 100, на уровне флагманов, и не могла заменить даже Sonnet. Haiku 4.5 считалась такой же «лёгкой», как Gemini 3.8 Flash (91,7), хотя набрала 68,7. GPT-OSS 120B считалась «сильной» и могла заменить Sonnet, хотя в аудите завис на 7 минут и не дал ответа. Теперь первые правила файла взяты из замера, у каждого указана причина. GPT-6 Luna стала «сильной»: заменяет Sonnet, GPT-5.5 и другие сильные модели, а флагманов — только если разрешена «чуть более слабая» модель. Флагманом она не считается: русский текст у неё слабый. Haiku 4.5 и псевдоним `haiku` получили новый уровень «слабая» (0,5). Haiku заменяет только такие же слабые модели или лёгкие, если разрешена «чуть более слабая»; сильную модель Haiku не заменяет никогда. Агенту на Haiku подходят лёгкие модели и лучше. GPT-OSS теперь берётся только из вашего пула, как неизвестная модель. Остальные модели по-прежнему оцениваются по названию, а следующая Haiku, например `claude-haiku-5`, до нового замера остаётся «лёгкой». Подсказка в разделе «Квоты» говорит, откуда берётся уровень. Код: `electron/model-tiers.json`. Тесты: `tests/failover.test.cjs` (ранги по замеру и выбор замены для Sonnet, Gemini Flash и Haiku). Пункт 5 раздела «Что аудит показал про сам Orbit» в `docs/MODEL-AUDIT.md`.
""",
)])
