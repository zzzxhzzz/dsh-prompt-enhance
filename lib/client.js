/**
 * Client half of the 增强提示词 plugin.
 *
 * This is the browser bundle the host serves for package `dsh-prompt-enhance`;
 * `dsh-client-modules` materializes `factory(require)` and Cordis activates the
 * returned plugin. It registers one button into the composer's left tool row
 * (`conversation.input.left`), reads the live draft through the slot's
 * `useInput` selector face, writes the result back through `inputActions.setDraft`,
 * and never submits anything.
 *
 * Failure policy, in one line: the draft is written only on a complete success
 * that still matches the text that was sent — every other path leaves the
 * user's text exactly as typed.
 *
 * Styles render as React elements inside the component, so unloading the entry
 * (plugin reload, profile patch, HMR) removes them with the fiber; nothing is
 * appended to `document.head` or `document.body`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Rewrite route served by this package's host half. */
    const REWRITE_ROUTE = '/api/prompt-enhance/rewrite';

    /** Policy route: `{ enableButton, maxInputLength }`. */
    const CONFIG_ROUTE = '/api/prompt-enhance/config';

    /** Client backstop only; the host's own timeout answers first. */
    const CLIENT_TIMEOUT_MS = 60_000;

    /** Used before the policy route answers, and when it cannot be reached. */
    const FALLBACK_LIMITS = { enableButton: true, maxInputLength: 4000 };

    const CSS = [
      '.dsh-pe { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }',
      '.dsh-pe-btn { display: inline-flex; align-items: center; justify-content: center;',
      '  width: 28px; height: 28px; padding: 0; border: 1px solid var(--dsw-alias-border-l1);',
      '  border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary);',
      '  cursor: pointer; }',
      '.dsh-pe-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2);',
      '  color: var(--dsw-alias-label-primary); }',
      '.dsh-pe-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.dsh-pe-btn:disabled { cursor: not-allowed; opacity: 0.45; }',
      '.dsh-pe-msg { font-size: 12px; line-height: 1.2; max-width: 220px; overflow: hidden;',
      '  text-overflow: ellipsis; white-space: nowrap;',
      '  color: var(--dsw-alias-state-error-primary); }',
      '.dsh-pe-msg[data-tone="info"] { color: var(--dsw-alias-label-secondary); }',
      '.dsh-pe-spin { animation: dsh-pe-rotate 0.9s linear infinite; transform-origin: 50% 50%; }',
      '@keyframes dsh-pe-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
    ].join('\n');

    /** Wand-with-sparkle glyph, drawn inline so no client package is imported. */
    function EnhanceIcon() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      },
        h('path', {
          d: 'M9.6 2.2 10.5 5l2.8.9-2.8.9-.9 2.8-.9-2.8L6 5.9l2.7-.9z',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M2.6 13.4 7.4 8.6',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M12.4 11.2v2.4M11.2 12.4h2.4',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
        }),
      );
    }

    /** Busy glyph: the same ring, animated by CSS. */
    function BusyIcon() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        className: 'dsh-pe-spin',
      },
        h('circle', {
          cx: 8,
          cy: 8,
          r: 5.4,
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeOpacity: 0.25,
        }),
        h('path', {
          d: 'M8 2.6a5.4 5.4 0 0 1 5.4 5.4',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      );
    }

    /** Read the live draft through the slot's selector face. */
    function readDraft(props) {
      const selector = props.useInput;
      if (typeof selector !== 'function') return '';
      const draft = selector((state) => (state === undefined || state === null ? '' : state.draft));
      return typeof draft === 'string' ? draft : '';
    }

    /** Product copy for one failed envelope; provider text never reaches here. */
    function messageOf(payload) {
      const message = payload !== null && typeof payload === 'object'
        ? payload.error?.message
        : undefined;
      return typeof message === 'string' && message.length > 0
        ? message
        : '增强失败，已保留原始输入';
    }

    /**
     * The composer button.
     *
     * @param props - the slot's standard props (`useInput`, `inputActions`).
     */
    function EnhanceButton(props) {
      const draft = readDraft(props);
      const actions = props.inputActions;
      const latest = React.useRef(draft);
      latest.current = draft;

      const busyRef = React.useRef(false);
      const lastDraft = React.useRef(draft);
      const [busy, setBusy] = React.useState(false);
      const [limits, setLimits] = React.useState(FALLBACK_LIMITS);
      const [notice, setNotice] = React.useState(null);

      // Editing after a failure clears the error; an informational notice stays.
      React.useEffect(() => {
        if (lastDraft.current === draft) return;
        lastDraft.current = draft;
        setNotice((current) => (current !== null && current.tone === 'info' ? current : null));
      }, [draft]);

      React.useEffect(() => {
        let alive = true;
        const controller = new AbortController();
        fetch(CONFIG_ROUTE, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((value) => {
            if (!alive || value === null || typeof value !== 'object') return;
            setLimits({
              enableButton: value.enableButton !== false,
              maxInputLength: Number.isInteger(value.maxInputLength) ? value.maxInputLength : FALLBACK_LIMITS.maxInputLength,
            });
          })
          .catch(() => {});
        return () => {
          alive = false;
          controller.abort();
        };
      }, []);

      const empty = draft.trim() === '';
      // Code points, matching the host's limit so one emoji is one character here too.
      const used = [...draft.trim()].length;
      const tooLong = !empty && used > limits.maxInputLength;
      const disabled = busy || empty || tooLong || !limits.enableButton;

      const onClick = React.useCallback(async () => {
        if (busyRef.current) return;
        const actionsRef = actions;
        if (actionsRef === undefined || typeof actionsRef.setDraft !== 'function') return;
        const sentText = latest.current.trim();
        if (sentText === '') return;

        busyRef.current = true;
        setBusy(true);
        setNotice(null);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
        try {
          const response = await fetch(REWRITE_ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ text: sentText, mode: 'balanced', feedback: '' }),
            signal: controller.signal,
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok || payload === null || payload.ok !== true) {
            setNotice({ tone: 'error', text: messageOf(payload) });
            return;
          }
          const result = typeof payload.result === 'string' ? payload.result.trim() : '';
          if (result === '') {
            setNotice({ tone: 'error', text: '模型没有返回内容，已保留原始输入' });
            return;
          }
          if (latest.current.trim() !== sentText) {
            // The user kept typing while the model worked: do not overwrite it.
            setNotice({ tone: 'info', text: '输入已变化，未回填' });
            return;
          }
          actionsRef.setDraft(result);
        } catch (error) {
          const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError';
          setNotice({ tone: 'error', text: aborted ? '请求超时，已保留原始输入' : '请求失败，已保留原始输入' });
        } finally {
          clearTimeout(timer);
          busyRef.current = false;
          setBusy(false);
        }
      }, [actions]);

      if (!limits.enableButton) return null;

      const title = busy
        ? '正在增强提示词…'
        : empty
          ? '先输入内容'
          : tooLong
            ? `输入超过 ${limits.maxInputLength} 字符`
            : '增强提示词';

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('span', { className: 'dsh-pe' },
          h('button', {
            type: 'button',
            className: 'dsh-pe-btn',
            'data-dsh-prompt-enhance': '1',
            title,
            'aria-label': title,
            'aria-busy': busy ? 'true' : undefined,
            disabled,
            onClick,
          }, busy ? h(BusyIcon) : h(EnhanceIcon)),
          notice === null ? null : h('span', {
            className: 'dsh-pe-msg',
            'data-tone': notice.tone,
            role: 'status',
          }, notice.text),
        ),
      );
    }

    /**
     * Register the button for the lifetime of this plugin fiber.
     *
     * @param ctx - client context; `slots` is the slot registry service.
     */
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined || slots === null) return;
      ctx.effect(() => slots.inject('conversation.input.left', () => slots.register({
        name: 'conversation.input.left',
        id: 'prompt-enhance',
        order: 30,
        label: () => '增强提示词',
      }, EnhanceButton)), 'prompt-enhance: composer button');
    }

    return {
      // Client runtime service dependency: the slot registry, resolved by Cordis
      // before `apply` runs. Unrelated to `dsh.client.inject` in package.json,
      // which only orders package activation.
      inject: ['slots'],
      apply,
    };
  },
});
