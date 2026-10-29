import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import Collaboration from '@tiptap/extension-collaboration'
import Placeholder from '@tiptap/extension-placeholder'
import type * as Y from 'yjs'
import { fragmentToHTML, noteExtensions, toggleTask } from '../model/noteSchema'
import { voice } from '../ai/voice'
import { NOTE_FONT_SIZE, type NoteItem } from '../model/types'
import { useBackLayer } from '../lib/back'
import { useCoarse } from '../lib/touch'
import { useSession, useSnapshot } from '../state/session'
import { useUi, useUiDispatch } from '../state/ui'
import { openMenu } from './ContextMenu'
import { Icon } from './Icons'
import s from './Note.module.css'

/** The note's look: its colour and text size (the window shows text a little larger). */
const boxStyle = (item: NoteItem, k = 1) => ({ background: item.color, fontSize: NOTE_FONT_SIZE * k })

/** The note's title, editable in place; Enter moves on to the text. */
function TitleInput({ item, editor, big }: { item: NoteItem; editor: Editor | null; big?: boolean }) {
  const { store } = useSession()
  return (
    <input
      className={`${s.title} ${big ? s.big : ''}`}
      value={item.title ?? ''}
      placeholder="Title"
      aria-label="Note title"
      maxLength={200}
      onChange={(e) => store.update(item.id, { title: e.target.value || undefined })}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== 'ArrowDown') return
        e.preventDefault()
        if (!editor) return
        // focus synchronously (Tiptap's focus command waits a frame), so the next keystroke lands in the text
        editor.view.focus()
        editor.commands.focus('start')
      }}
    />
  )
}

/** "…" under the text while a voice note is still coming into this note. */
function VoiceDots({ id }: { id: string }) {
  const waiting = useSyncExternalStore(voice.subscribe, () => voice.waiting(id))
  if (!waiting) return null
  return (
    <div className={s.dots} role="status" aria-label="Listening">
      <i />
      <i />
      <i />
    </div>
  )
}

export function NoteBody({ item, editing }: { item: NoteItem; editing: boolean }) {
  const { store } = useSession()
  const fragment = useMemo(() => store.noteFragment(item.id), [store, item.id])
  if (!fragment) return null
  return editing ? <NoteEditor fragment={fragment} item={item} /> : <NoteStatic fragment={fragment} item={item} />
}

function NoteStatic({ fragment, item }: { fragment: Y.XmlFragment; item: NoteItem }) {
  const { store } = useSession()
  const coarse = useCoarse()
  const waiting = useSyncExternalStore(voice.subscribe, () => voice.waiting(item.id))
  const [html, setHtml] = useState(() => fragmentToHTML(fragment))
  useEffect(() => {
    let raf = 0
    const refresh = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setHtml(fragmentToHTML(fragment)))
    }
    refresh()
    fragment.observeDeep(refresh)
    return () => {
      fragment.unobserveDeep(refresh)
      cancelAnimationFrame(raf)
    }
  }, [fragment])
  // checkboxes toggle in place; the doc is the source of truth, so cancel the DOM's own flip
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = (e.target as HTMLElement).closest('input[type=checkbox]')
    const li = box?.closest('li[data-type=taskItem]')
    if (!li) return
    e.preventDefault()
    const index = [...e.currentTarget.querySelectorAll('li[data-type=taskItem]')].indexOf(li)
    store.transact(() => toggleTask(fragment, index))
  }
  return (
    <div className={s.box} style={boxStyle(item)}>
      {item.title && <div className={s.title}>{item.title}</div>}
      <div className={s.prose} onClick={onClick}>
        {/* an empty note being spoken into shows just the dots, not the "write here" hint */}
        <div dangerouslySetInnerHTML={{ __html: html || (waiting ? '' : `<p class="empty">${coarse ? 'Double-tap' : 'Double-click'} to write…</p>`) }} />
        {/* right after the text, where the next words will appear */}
        <VoiceDots id={item.id} />
      </div>
    </div>
  )
}

function useNoteEditor(fragment: Y.XmlFragment) {
  return useEditor(
    {
      extensions: [...noteExtensions, Placeholder.configure({ placeholder: 'Write something… (markdown works: # , **bold**, - , [ ] )' }), Collaboration.configure({ fragment })],
      autofocus: 'end',
    },
    [fragment],
  )
}

// the in-place editor lives in the zoomed world layer; its toolbar is drawn by the screen-space ContextBar
let boardEditor: Editor | null = null
const listeners = new Set<() => void>()
const setBoardEditor = (e: Editor | null) => {
  boardEditor = e
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
export const useBoardNoteEditor = () => useSyncExternalStore(subscribe, () => boardEditor)

function NoteEditor({ fragment, item }: { fragment: Y.XmlFragment; item: NoteItem }) {
  const editor = useNoteEditor(fragment)
  useEffect(() => {
    if (!editor) return
    setBoardEditor(editor)
    return () => {
      if (boardEditor === editor) setBoardEditor(null)
    }
  }, [editor])
  return (
    <div className={s.box} style={boxStyle(item)}>
      <TitleInput item={item} editor={editor} />
      <EditorContent editor={editor} className={`${s.prose} ${s.editing}`} />
      <VoiceDots id={item.id} />
    </div>
  )
}

/** The open note from ui.noteModal, in a large window over everything. */
export function NoteModal() {
  const { noteModal } = useUi()
  const dispatch = useUiDispatch()
  const { store } = useSession()
  const snap = useSnapshot()
  const item = noteModal ? snap.all.get(noteModal) : undefined
  const gone = !!noteModal && item?.type !== 'note'
  useEffect(() => {
    if (gone) dispatch({ type: 'noteModal', id: null })
  }, [gone, dispatch])
  const fragment = useMemo(() => (item?.type === 'note' ? store.noteFragment(item.id) : null), [store, item?.id, item?.type])
  if (item?.type !== 'note' || !fragment) return null
  return <NoteWindow key={item.id} fragment={fragment} item={item} onClose={() => dispatch({ type: 'noteModal', id: null })} />
}

function NoteWindow({ fragment, item, onClose }: { fragment: Y.XmlFragment; item: NoteItem; onClose: () => void }) {
  const editor = useNoteEditor(fragment)
  useBackLayer(true, onClose)
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className={s.backdrop} onClick={onClose} data-nodrag>
      <div className={s.window} style={boxStyle(item, 17 / 15)} onClick={(e) => e.stopPropagation()}>
        <div className={s.windowHead}>
          {editor && <NoteToolbar editor={editor} variant="inline" />}
          <button className={s.close} onClick={onClose} title="Close  Esc" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <TitleInput item={item} editor={editor} big />
        <EditorContent editor={editor} className={`${s.prose} ${s.editing} ${s.big}`} />
        <VoiceDots id={item.id} />
      </div>
    </div>
  )
}

const LEVELS = [1, 2, 3, 4, 5, 6] as const

export function NoteToolbar({ editor, variant }: { editor: Editor; variant: 'inline' | 'bare' }) {
  const [, force] = useState(0)
  useEffect(() => {
    const h = () => force((n) => n + 1)
    editor.on('transaction', h)
    return () => void editor.off('transaction', h)
  }, [editor])
  const B = (name: string, icon: string, run: () => void, active: boolean) => (
    <button key={name} className={active ? s.on : ''} title={name} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      <Icon name={icon} size={15} />
    </button>
  )
  const c = () => editor.chain().focus()
  return (
    <div className={`${s.toolbar} ${s[variant]}`} data-nodrag>
      <button
        className={s.headingSize}
        title="Heading size"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const cur = LEVELS.find((n) => editor.isActive('heading', { level: n }))
          openMenu(
            { clientX: r.left, clientY: r.bottom + 6, preventDefault() {}, stopPropagation() {} },
            [
              { label: 'Normal text', icon: cur ? undefined : 'check', onSelect: () => c().setParagraph().run() },
              ...LEVELS.map((n) => ({
                label: `Heading ${n}`,
                icon: n === cur ? 'check' : undefined,
                onSelect: () => c().setHeading({ level: n }).run(),
              })),
            ],
          )
        }}
      >
        Aa
      </button>
      {B('Bold', 'bold', () => c().toggleBold().run(), editor.isActive('bold'))}
      {B('Italic', 'italic', () => c().toggleItalic().run(), editor.isActive('italic'))}
      {B('Strike', 'strike', () => c().toggleStrike().run(), editor.isActive('strike'))}
      {B('Bullets', 'ul', () => c().toggleBulletList().run(), editor.isActive('bulletList'))}
      {B('Numbers', 'ol', () => c().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {B('Checklist', 'check', () => c().toggleTaskList().run(), editor.isActive('taskList'))}
      {B('Code', 'code', () => c().toggleCodeBlock().run(), editor.isActive('codeBlock'))}
    </div>
  )
}
