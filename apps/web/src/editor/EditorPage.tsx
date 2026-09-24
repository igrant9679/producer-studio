export function EditorPage({ demo = false }: { demo?: boolean }) {
  return <div>editor {demo ? 'demo' : ''}</div>
}
