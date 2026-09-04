import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react'
import { Button, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'

import { VAULT_ENDPOINTS, VAULT_RPC_CHANNEL } from '../lib/api.js'
import { NS, zh, en } from './locales.js'
import { PAGE_SIZE, dateRangeMs, filterRows, paginate } from './paging.js'
import css from './index.css'

export const name = 'dsh-session-vault'
export const inject = ['slots', 'locale', 'connection']

const STYLE_ID = 'dsh-session-vault-css'

function cwdLeaf(cwd) {
  if (!cwd) return ''
  const parts = String(cwd).replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || cwd
}

function fmt(t, key, vars) {
  let text = t(key)
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = String(text).split(`{${name}}`).join(String(value))
    }
  }
  return text
}

function formatTime(createdAt) {
  if (!Number.isFinite(createdAt)) return ''
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : undefined
  try {
    return new Date(createdAt).toLocaleString(lang || undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(createdAt)
  }
}

function SessionRow({ row, checked, disabled, t, onToggle, onDelete }) {
  const title = row.title?.trim() ? row.title : t('untitled')
  const folder = cwdLeaf(row.cwd)
  return h('li', { className: disabled ? 'dsh-sv-row is-current' : 'dsh-sv-row' },
    h('input', {
      type: 'checkbox',
      className: 'dsh-sv-check',
      checked,
      disabled,
      'aria-label': title,
      onChange: () => onToggle(row.sessionId),
    }),
    h('div', { className: 'dsh-sv-main' },
      h('div', { className: 'dsh-sv-line' },
        h('span', { className: 'dsh-sv-name', title }, title),
        row.archived ? h('span', { className: 'dsh-sv-badge' }, t('archived')) : null,
        row.blank ? h('span', { className: 'dsh-sv-badge' }, t('blank')) : null,
        row.live ? h('span', { className: 'dsh-sv-badge' }, t('live')) : null,
        disabled ? h('span', { className: 'dsh-sv-badge' }, t('current')) : null,
      ),
      h('div', { className: 'dsh-sv-meta' },
        h('span', { className: 'dsh-sv-place', title: row.cwd || undefined },
          [folder, formatTime(row.createdAt)].filter(Boolean).join(' · ')),
        row.sessionId
          ? h('span', { className: 'dsh-sv-id', title: row.sessionId }, row.sessionId)
          : null,
      ),
    ),
    h(Button, {
      variant: 'ghost',
      size: 'sm',
      disabled,
      onClick: () => onDelete([row.sessionId]),
    }, t('delete')),
  )
}

export function ArchiveSection({ t, rpcCall, useSessions }) {
  const currentId = useSessions((s) => s.current)
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState(null)
  const [items, setItems] = useState([])
  const [kind, setKind] = useState('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(() => new Set())
  const [pending, setPending] = useState(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setStatus('loading')
    setError(null)
    try {
      const result = await rpcCall(VAULT_ENDPOINTS.list, {})
      if (!result?.ok) throw new Error(result?.error?.message ?? t('error'))
      setItems(result.value.items ?? [
        ...(result.value.archived ?? []),
        ...(result.value.blank ?? []),
      ])
      setSelected(new Set())
      setPage(1)
      setStatus('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    }
  }, [rpcCall, t])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const range = dateRangeMs(fromDate, toDate)
    return filterRows(items, { kind, ...range })
  }, [items, kind, fromDate, toDate])

  const paged = useMemo(() => paginate(filtered, page, PAGE_SIZE), [filtered, page])

  useEffect(() => {
    if (page !== paged.page) setPage(paged.page)
  }, [page, paged.page])

  const pageIds = useMemo(
    () => paged.items.map((row) => row.sessionId).filter((id) => id !== currentId),
    [paged.items, currentId],
  )

  const toggle = useCallback((id) => {
    if (id === currentId) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [currentId])

  const togglePage = useCallback(() => {
    setSelected((prev) => {
      const allSelected = pageIds.length > 0 && pageIds.every((id) => prev.has(id))
      const next = new Set(prev)
      if (allSelected) {
        for (const id of pageIds) next.delete(id)
      } else {
        for (const id of pageIds) next.add(id)
      }
      return next
    })
  }, [pageIds])

  const requestDelete = useCallback((ids) => {
    const eligible = ids.filter((id) => id !== currentId)
    if (eligible.length === 0) {
      setError(t('noneSelected'))
      return
    }
    setError(null)
    setAcknowledged(false)
    setPending(eligible)
  }, [currentId, t])

  const confirmDelete = useCallback(async () => {
    if (!pending || pending.length === 0) return
    setBusy(true)
    try {
      const result = await rpcCall(VAULT_ENDPOINTS.delete, {
        sessionIds: pending,
        ...currentId === undefined ? {} : { keepSessionId: currentId },
      })
      if (!result?.ok) throw new Error(result?.error?.message ?? t('error'))
      const failed = (result.value.results ?? []).filter((row) => row.ok !== true)
      setPending(null)
      setAcknowledged(false)
      await load()
      if (failed.length > 0) {
        setError(`${fmt(t, 'deleteFailed', { n: failed.length })} ${failed.map((row) => row.error).filter(Boolean).join(' ')}`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [currentId, load, pending, rpcCall, t])

  if (status === 'loading' && items.length === 0) {
    return h('div', { className: 'dsh-sv' },
      h('p', { className: 'dsh-sv-muted' }, t('loading')),
    )
  }
  if (status === 'error' && items.length === 0) {
    return h('div', { className: 'dsh-sv' },
      h('p', { className: 'dsh-sv-error', role: 'alert' }, error ?? t('error')),
      h(Button, { variant: 'outline', onClick: () => void load() }, t('retry')),
    )
  }

  return h('div', { className: 'dsh-sv' },
    h('div', { className: 'dsh-sv-head' },
      h('h2', { className: 'dsh-sv-title' }, t('title')),
      h('p', { className: 'dsh-sv-intro' }, t('intro')),
    ),
    error ? h('p', { className: 'dsh-sv-error', role: 'alert' }, error) : null,
    h('div', { className: 'dsh-sv-chrome' },
      h('div', { className: 'dsh-sv-cluster' },
        [['all', t('all')], ['archived', t('archived')], ['blank', t('blank')]].map(([id, label]) =>
          h(Button, {
            key: id,
            variant: kind === id ? 'primary' : 'ghost',
            size: 'sm',
            onClick: () => { setKind(id); setPage(1) },
          }, label),
        ),
      ),
      h('div', { className: 'dsh-sv-cluster' },
        h('input', {
          type: 'date',
          className: 'dsh-sv-date',
          'aria-label': t('dateFrom'),
          value: fromDate,
          onChange: (event) => { setFromDate(event.target.value); setPage(1) },
        }),
        h('span', { className: 'dsh-sv-muted' }, '–'),
        h('input', {
          type: 'date',
          className: 'dsh-sv-date',
          'aria-label': t('dateTo'),
          value: toDate,
          onChange: (event) => { setToDate(event.target.value); setPage(1) },
        }),
        fromDate || toDate
          ? h(Button, {
            variant: 'ghost',
            size: 'sm',
            onClick: () => { setFromDate(''); setToDate(''); setPage(1) },
          }, t('clearDates'))
          : null,
      ),
    ),
    h('div', { className: 'dsh-sv-chrome' },
      h('div', { className: 'dsh-sv-cluster' },
        h(Button, { variant: 'outline', size: 'sm', onClick: togglePage, disabled: pageIds.length === 0 }, t('selectPage')),
        h(Button, {
          variant: 'primary',
          size: 'sm',
          disabled: selected.size === 0 || busy,
          onClick: () => requestDelete([...selected]),
        }, t('deleteSelected')),
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => void load(), disabled: busy }, t('refresh')),
      ),
      h('span', { className: 'dsh-sv-muted' },
        selected.size > 0
          ? `${fmt(t, 'selected', { n: selected.size })} · ${fmt(t, 'total', { n: paged.total })}`
          : fmt(t, 'total', { n: paged.total }),
      ),
    ),
    paged.items.length === 0
      ? h('p', { className: 'dsh-sv-muted dsh-sv-empty' }, t('empty'))
      : h('ul', { className: 'dsh-sv-list' },
        paged.items.map((row) => h(SessionRow, {
          key: row.sessionId,
          row,
          t,
          checked: selected.has(row.sessionId),
          disabled: row.sessionId === currentId,
          onToggle: toggle,
          onDelete: requestDelete,
        })),
      ),
    paged.pageCount > 1
      ? h('div', { className: 'dsh-sv-chrome' },
        h('div', { className: 'dsh-sv-cluster' },
          h(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: paged.page <= 1,
            onClick: () => setPage(paged.page - 1),
          }, t('prev')),
          h(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: paged.page >= paged.pageCount,
            onClick: () => setPage(paged.page + 1),
          }, t('next')),
        ),
        h('span', { className: 'dsh-sv-muted' }, fmt(t, 'page', { page: paged.page, pages: paged.pageCount })),
      )
      : null,
    h(RiskConfirmation, {
      open: pending !== null,
      title: t('deleteTitle'),
      description: fmt(t, 'deleteDescription', { n: pending?.length ?? 0 }),
      acknowledgeLabel: t('acknowledge'),
      cancelLabel: t('cancel'),
      confirmLabel: busy ? t('deleting') : t('confirm'),
      acknowledged,
      disabled: busy,
      onAcknowledgedChange: setAcknowledged,
      onCancel: () => {
        if (busy) return
        setPending(null)
        setAcknowledged(false)
      },
      onConfirm: () => { void confirmDelete() },
    }),
  )
}

function mountStyles() {
  if (document.getElementById(STYLE_ID)) return () => {}
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = css
  document.head.appendChild(el)
  return () => el.remove()
}

export function apply(ctx) {
  ctx.effect(() => mountStyles(), 'dsh-session-vault: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-vault: locale dictionaries')
  const t = ctx.locale.bind(NS)
  const rpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(VAULT_RPC_CHANNEL, endpoint, payload, signal)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'session-vault',
    order: 12,
    locale: NS,
    label: () => t('nav'),
    inject: () => ({ rpcCall, t }),
  }, ArchiveSection))
}
