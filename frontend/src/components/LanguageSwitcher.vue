<template>
  <el-dropdown @command="handleCommand">
    <span class="language-switcher">
      {{ currentLanguage === 'zh' ? '中文' : '日本語' }}
      <el-icon class="el-icon--right"><arrow-down /></el-icon>
    </span>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="zh">中文</el-dropdown-item>
        <el-dropdown-item command="ja">日本語</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown } from '@element-plus/icons-vue'

const { locale } = useI18n()
const currentLanguage = computed(() => locale.value)

const handleCommand = (command: string) => {
  locale.value = command
  // 可以在这里保存用户的语言偏好到 localStorage
  localStorage.setItem('preferredLanguage', command)
}

// 在组件挂载时读取用户的语言偏好
const initLanguage = () => {
  const savedLanguage = localStorage.getItem('preferredLanguage')
  if (savedLanguage && ['zh', 'ja'].includes(savedLanguage)) {
    locale.value = savedLanguage
  }
}

// 组件挂载时初始化语言
initLanguage()
</script>

<style scoped>
.language-switcher {
  cursor: pointer;
  display: flex;
  align-items: center;
  color: var(--el-text-color-primary);
}

.el-icon--right {
  margin-left: 5px;
}
</style> 