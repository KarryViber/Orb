import { createI18n } from 'vue-i18n'
import zh from './locales/zh'
import ja from './locales/ja'

const i18n = createI18n({
  legacy: false, // 使用 Composition API 模式
  locale: 'ja', // 默认语言
  fallbackLocale: 'zh', // 回退语言
  messages: {
    zh,
    ja
  }
})

export default i18n 