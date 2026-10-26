import { useEffect, useMemo, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import Collaboration from '@tiptap/extension-collaboration'
import Placeholder from '@tiptap/extension-placeholder'
import type * as Y from 'yjs'
import { fragmentToHTML, noteExtensions } from '../model/noteSchema'
import type { NoteItem } from '../model/types'
import { useSession } from '../state/session'
import { Icon } from './Icons'
import s from './Note.module.css'

export function NoteBody({ item, editing }: { item: NoteItem; editing: boolean }) {
  const { store } = useSession()
  const fragment = useMemo(() => store.noteFragment(item.id), [store, item.id])
  if (!fragment) return null
  return editing ? <NoteEditor fragment={fragment} color={item.color} /> : <NoteStatic fragment={fragment} color={item.color} />
}

function NoteStatic({ fragment, color }: { fragment: Y.XmlFragment; color: string }) {
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
  return (
    <div className={s.box} style={{ background: color }}>
      <div className={s.prose} dangerouslySetInnerHTML={{ __html: html || '<p class="empty">Double-click to write…</p>' }} />
    </div>
  )
}

function NoteEditor({ fragment, color }: { fragment: Y.XmlFragment; color: string }) {
  const editor = useEditor(
    {
      extensions: [...noteExtensions, Placeholder.configure({ placeholder: 'Write something… (markdown works: # , **bold**, - , [ ] )' }), Collaboration.configure({ fragment })],
      autofocus: 'end',
    },
    [fragment],
  )
  return (
    <>
      <div className={s.box} style={{ background: color }}>
        <EditorContent editor={editor} className={`${s.prose} ${s.editing}`} />
      </div>
      {editor && <Toolbar editor={editor} />}
    </>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
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
    <div className={s.toolbar} data-nodrag>
      {B('Bold', 'bold', () => c().toggleBold().run(), editor.isActive('bold'))}
      {B('Italic', 'italic', () => c().toggleItalic().run(), editor.isActive('italic'))}
      {B('Strike', 'strike', () => c().toggleStrike().run(), editor.isActive('strike'))}
      {B('Heading', 'heading', () => c().toggleHeading({ level: 3 }).run(), editor.isActive('heading'))}
      {B('Bullets', 'ul', () => c().toggleBulletList().run(), editor.isActive('bulletList'))}
      {B('Numbers', 'ol', () => c().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {B('Checklist', 'check', () => c().toggleTaskList().run(), editor.isActive('taskList'))}
      {B('Code', 'code', () => c().toggleCodeBlock().run(), editor.isActive('codeBlock'))}
    </div>
  )
}
