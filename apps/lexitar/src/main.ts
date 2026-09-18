import { mount } from 'svelte'
import './app.css'
import '@tinytars/frame/theme.css'
import './styles/tokens.css'
import './styles/footer.css'
import App from './App.svelte'
import { installErrorReporter } from './lib/error-reporter'

installErrorReporter()

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
