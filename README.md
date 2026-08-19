# deepseek-harness-retry

Автоматический retry временных и generic-ошибок моделей в [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Плагин решает ситуацию, когда GPT/Claude/другая модель иногда отвечает внутренней ошибкой, а повтор того же запроса вручную сразу срабатывает. Он подключается к Host-событию `agent/request-error`, сначала даёт встроенным recovery-политикам DSH обработать ошибку, а затем выполняет ограниченный retry с exponential backoff.

## Возможности

- обрабатывает generic `PI_AI_ERROR` (частый случай для GPT-маршрутов), `UNKNOWN` и стандартные transient-коды;
- по умолчанию делает до **2 повторов** после исходного запроса;
- exponential backoff: 500 ms → 1 s, максимум 10 s;
- jitter предотвращает синхронные повторные запросы;
- учитывает `Retry-After` провайдера и не повторяет запрос раньше указанного срока;
- фильтрует retry по provider и failure code;
- корректно прекращает ожидание при cancel/dispose;
- сначала делегирует встроенным recovery-плагинам DSH, поэтому не перехватывает compaction и другие специализированные политики;
- записывает стандартные non-surface события `llm/retry` и `llm/retry-started`, совместимые с persistence и Web UI DSH.

Ошибка и ожидание не добавляются в model-visible history. Каждый retry является новым запросом к провайдеру и может тарифицироваться отдельно.

## Установка

Установите пакет в нужный DSH profile:

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
    maxDelayMs: 15000
    jitterRatio: 0.15
    respectRetryAfter: true
    providers:
      - openai
      - openrouter
    excludeProviders: []
```

| Опция | По умолчанию | Описание |
|---|---:|---|
| `maxRetries` | `2` | Число повторов после исходной ошибки; `0` отключает plugin. |
| `retryableCodes` | см. ниже | Точные provider-neutral коды. Значение `*` повторяет любую request error. |
| `initialDelayMs` | `500` | Начальная задержка exponential backoff. |
| `maxDelayMs` | `10000` | Максимальная локальная задержка; больший `Retry-After` оставляет ошибку terminal. |
| `jitterRatio` | `0.1` | Симметричный jitter от `0` до `1`. |
| `providers` | `[]` | Allowlist provider routes; пустой список разрешает все. |
| `excludeProviders` | `[]` | Denylist provider routes; имеет приоритет над allowlist. |
| `respectRetryAfter` | `true` | Использовать provider `Retry-After`; не retry, если он выше `maxDelayMs`. |

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

## Разработка

```bash
pnpm install
pnpm check
pnpm pack --dry-run
```

Требования: Node.js 20+ и DeepSeek Harness `0.1.0-rc.7` или новее.

## License

MIT
