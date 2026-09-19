import { mount } from 'svelte'
import '@tinytars/frame/footer.css'
import './app.css'
import '@tinytars/frame/theme.css'
import App from './App.svelte'
import { installErrorReporter } from './lib/error-reporter'

installErrorReporter()

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
