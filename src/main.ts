import { mount } from 'svelte'
import './app.css'
import '@tinytars/frame/theme.css'
import '@tars/styles/tokens.css'
import '@tars/styles/footer.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
