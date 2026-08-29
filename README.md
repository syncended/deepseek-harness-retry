# @syncended/dsh-retry

Автоматический retry временных и generic-ошибок моделей в [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Плагин решает ситуацию, когда GPT/Claude/другая модель иногда отвечает внутренней ошибкой, а повтор того же запроса вручную сразу срабатывает. Он подключается к Host-событию `agent/request-error`, сначала даёт встроенным recovery-политикам DSH обработать ошибку, а затем выполняет ограниченный retry с exponential backoff.

## Возможности

- обрабатывает generic `PI_AI_ERROR` (частый случай для GPT-маршрутов), `UNKNOWN` и стандартные transient-коды;
- по умолчанию делает до **2 повторов** после исходного запроса;
- для явного ответа Codex `servers are currently overloaded` делает до **5 повторов** с более длинным backoff;
- exponential backoff: 500 ms → 1 s, максимум 10 s (для overload начинается с 2 s);
- jitter предотвращает синхронные повторные запросы;
- учитывает `Retry-After` провайдера и не повторяет запрос раньше указанного срока;
- фильтрует retry по provider и failure code;
- корректно прекращает ожидание при cancel/dispose;
- после crash/restart продолжает только доказанно незавершённую работу: unmatched собственный `llm/retry` либо последний model step без `assistant/message`;
- никогда не продолжает завершённый ответ, ручной `aborted/user`, чужой или уже начатый retry turn;
- не изменяет существующий durable inbox и не перехватывает пользовательский cancel;
- сначала делегирует встроенным recovery-плагинам DSH, поэтому не перехватывает compaction и другие специализированные политики;
- записывает стандартные non-surface события `llm/retry` и `llm/retry-started`, совместимые с persistence и Web UI DSH.

Ошибка и ожидание не добавляются в model-visible history. Каждый retry является новым запросом к провайдеру и может тарифицироваться отдельно.

## Установка

Из npm после публикации:

```bash
dsh plugin --profile web add -w @syncended/dsh-retry
```

Напрямую из GitHub до первого npm-релиза или для проверки `trunk`:

```bash
dsh plugin --profile web add -w github:syncended/deepseek-harness-retry
```

Пакет объявлен как DSH bundle, поэтому CLI сам добавит его patch в профиль и смонтирует Host-плагин с id `model-error-retry`. Ручная вставка plugin entry не требуется. Перезапустите DSH после установки.

> Актуальные версии DSH уже содержат `@deepseek-ai/dsh-llm-retry` для `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT` и `TRANSPORT`. Этот плагин безопасно делегирует ему первым, а его defaults охватывают отсутствующие там generic model errors, в частности `PI_AI_ERROR`. Не удаляйте встроенный плагин: adapter-owned normal/always policy всегда имеет приоритет, и fallback не расширяет её budget.

## Конфигурация

Переопределите bundle row в `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: model-error-retry
  config:
    maxRetries: 3
    overloadMaxRetries: 5
    retryableCodes:
      - PI_AI_ERROR
      - UNKNOWN
      - STREAM_CLOSED
      - EMPTY_RESPONSE
      - RATE_LIMIT
      - SERVER
      - TIMEOUT
      - TRANSPORT
    initialDelayMs: 750
    overloadInitialDelayMs: 2000
    maxDelayMs: 15000
    jitterRatio: 0.15
    respectRetryAfter: true
    resumeInterrupted: true
    resumeDisposed: false
    resumeMaxAgeMs: 86400000
    resumePrompt: >-
      DeepSeek Harness stopped before the previous model request produced a complete
      assistant message, or before a scheduled retry started. Continue the unfinished
      response from the durable session history. Re-check the current workspace and
      external state before acting. Do not blindly repeat tool calls that may have side
      effects; verify their outcome first.
    providers:
      - openai
      - openrouter
    excludeProviders: []
```

| Опция | По умолчанию | Описание |
|---|---:|---|
| `maxRetries` | `2` | Число повторов после обычной исходной ошибки; `0` отключает request-error retry, но не `resumeInterrupted`. |
| `overloadMaxRetries` | `5` | Число повторов для `PI_AI_ERROR` с явным сообщением об overload. |
| `retryableCodes` | см. ниже | Точные provider-neutral коды. Значение `*` повторяет любую request error. |
| `initialDelayMs` | `500` | Начальная задержка обычного exponential backoff. |
| `overloadInitialDelayMs` | `2000` | Начальная задержка для явного provider overload. |
| `maxDelayMs` | `10000` | Максимальная локальная задержка; больший `Retry-After` оставляет ошибку terminal. |
| `jitterRatio` | `0.1` | Симметричный jitter от `0` до `1`. |
| `providers` | `[]` | Allowlist provider routes; пустой список разрешает все. |
| `excludeProviders` | `[]` | Denylist provider routes; имеет приоритет над allowlist. |
| `respectRetryAfter` | `true` | Использовать provider `Retry-After`; не retry, если он выше `maxDelayMs`. |
| `resumeInterrupted` | `true` | При cold resume продолжать unmatched собственный `llm/retry` либо crash-interrupted model step без `assistant/message`. |
| `resumeDisposed` | `false` | Также считать `aborted/disposed` допустимым завершением pending retry. Отключено, потому что disposed бывает при HMR и намеренном teardown. |
| `resumeMaxAgeMs` | `86400000` | Максимальный возраст pending retry для автопродолжения; по умолчанию 24 часа. |
| `resumePrompt` | см. пример | Model-visible инструкция для безопасного продолжения подтверждённого retry intent. |

Default retryable codes:

```text
STREAM_CLOSED, MALFORMED_RESPONSE, PI_AI_ERROR, API_ERROR, MODEL_ERROR,
INTERNAL_ERROR, PROVIDER_ERROR, UNKNOWN
```

Permanent failures (`AUTH`, `INVALID_REQUEST`, `MISSING_CREDENTIAL`, `UNKNOWN_MODEL`, context overflow и т. п.) по умолчанию не повторяются. При необходимости используйте точный код или `*`, помня о дополнительных расходах.

## Как это работает

1. Agent loop получает terminal model request failure.
2. Плагин вызывает следующий handler в waterfall `agent/request-error`.
3. Если встроенный handler уже вернул `{ kind: 'retry' }`, решение возвращается без дополнительного retry.
4. Иначе проверяются provider, failure code и локальный budget.
5. В session log записывается стандартное `llm/retry`, затем плагин ждёт abort-aware backoff.
6. После ожидания записывается `llm/retry-started` и возвращается `{ kind: 'retry' }`; DSH повторно собирает запрос из durable history.

Частично полученные chunks не попадают в следующий model-visible request: retry происходит на закрытой request-error границе agent loop.

### Восстановление после рестарта DSH

1. После `llm/retry` плагин запрашивает persistence checkpoint перед backoff. Если checkpoint недоступен, live retry продолжается, но restart recovery для этой попытки считается best-effort.
2. При crash persistence DSH балансирует открытый tail синтетическими tool errors, `step/end` и `turn/end` с причиной `interrupted`.
3. Когда Web/API снова присоединяет холодную сессию через `agents.resume`, плагин принимает один из двух durable proofs: собственный `llm/retry` без `llm/retry-started` либо последний crash-interrupted step, в котором есть durable user input, но нет `assistant/message`.
4. Завершённый `assistant/message`, ручной interrupt (`aborted/user`, включая partial message с `interrupted: true`), чужой policy key, уже начатая попытка, subagent и существующая inbox-очередь немедленно отбрасываются. `aborted/disposed` по умолчанию также не подходит.
5. Решение и enqueue выполняются внутри `agent.runMaintenance()`, с повторной проверкой exact live Agent. Существующий inbox никогда не удаляется и не переупорядочивается.
6. Только при пустом inbox добавляется один model-visible plugin notice с детерминированным message id; он открывает новый turn поверх сохранённой истории.

Провайдерский stream и старый JS Promise после перезапуска восстановить невозможно, поэтому это семантическое продолжение новым turn, а не продолжение тех же байтов request. Плагин не сканирует и не запускает архивные сессии при старте DSH — проверка происходит лениво при следующем подключении. Главный fail-closed инвариант: при неоднозначности работа не запускается автоматически.

## Разработка

```bash
pnpm install
pnpm check
npm pack --dry-run
```

Tag-driven npm-публикация описана в [`RELEASING.md`](./RELEASING.md).

Требования: Node.js 20+ и DeepSeek Harness линии `0.1.0-rc.7+` или `0.1.1-rc.2+`.

## License

MIT
