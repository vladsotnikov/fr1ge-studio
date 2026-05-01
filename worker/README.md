# Fr1Ge STUDIO License Worker

Cloudflare Worker валідує ліцензії + має кастомну адмін-панель для управління юзерами.

## Деплой (одноразово, ~10 хвилин)

### 1. Встанови wrangler CLI
```bash
npm install -g wrangler
wrangler login
```

### 2. Створи KV namespace
```bash
cd worker
wrangler kv namespace create VSS_KEYS
```

Скопіюй виведений `id` і встав у `wrangler.toml` замість `REPLACE_WITH_KV_ID_AFTER_FIRST_DEPLOY`.

### 3. Встанови admin token (пароль до панелі)

Згенеруй сильний пароль і збережи його як Worker secret:
```bash
wrangler secret put ADMIN_TOKEN
# Wrangler попросить ввести значення → введи довільний пароль (наприклад 32 символи)
```

⚠️ **Запам'ятай цей пароль** — ним заходитимеш в адмін-панель.

### 4. Деплой
```bash
wrangler deploy
```

Виведе URL типу `https://fr1ge-studio-license.YOUR-USERNAME.workers.dev`.

### 5. Прокинь URL у аппку
Відкрий `electron/license.cjs`:
```js
const VALIDATION_URL = "https://fr1ge-studio-license.YOUR-USERNAME.workers.dev";
```
Перебудуй DMG: `npm run build:mac`.

## 🎨 Адмін-панель

Заходь у браузері: **`https://fr1ge-studio-license.YOUR-USERNAME.workers.dev/admin`**

1. Увійди через ADMIN_TOKEN
2. Згори праворуч — поле "Імʼя/email юзера" + кнопка **"+ Згенерувати ключ"**:
   - Тиснеш → автоматично створюється `vss-xxxx-xxxx-xxxx`
   - Ключ автоматично копіюється у буфер обміну
3. Внизу — таблиця з усіма юзерами:
   - **Клік на ключ** копіює його в буфер
   - **Відкликати** — позначає `revoked: true` (юзер втратить доступ за до 7 днів)
   - **Активувати** — повертає доступ
   - **Видалити** — назавжди прибирає ключ

Сесія в браузері тримається до закриття вкладки (sessionStorage).

## Команди CLI (опціонально, паралельно з панеллю)

```bash
wrangler kv key list --binding=VSS_KEYS                              # усі ключі
wrangler kv key get  --binding=VSS_KEYS "vss-abc-123"                # один ключ
wrangler kv key put  --binding=VSS_KEYS "vss-abc-123" '{"user":"alex","revoked":false}'
wrangler kv key delete --binding=VSS_KEYS "vss-abc-123"
```

## Безкоштовний tier

Cloudflare Free дає 100k запитів/день, 1GB KV storage. Для 20 юзерів — використання менше 0.1% ліміту.
