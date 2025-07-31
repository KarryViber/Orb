<template>
  <el-container class="app-container">
    <el-aside width="200px" class="aside">
      <div class="logo">
        <span>Orb System</span>
      </div>
      <el-menu
        :default-active="route.path"
        class="el-menu-vertical"
        :router="true"
      >
        <el-menu-item index="/">
          <el-icon><HomeFilled /></el-icon>
          <span>{{ $t('menu.home') }}</span>
        </el-menu-item>
        
        <el-menu-item index="/search-tasks">
          <el-icon><Search /></el-icon>
          <span>{{ $t('menu.search') }}</span>
        </el-menu-item>
        
        <el-menu-item index="/message-tasks">
          <el-icon><Message /></el-icon>
          <span>{{ $t('menu.message') }}</span>
        </el-menu-item>
        
        <el-menu-item index="/users">
          <el-icon><UserFilled /></el-icon>
          <span>{{ $t('menu.users') }}</span>
        </el-menu-item>

        <div class="flex-spacer"></div>
        
        <el-menu-item index="/configs">
          <el-icon><Setting /></el-icon>
          <span>{{ $t('menu.settings') }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-left">
          <el-icon
            class="collapse-btn"
            @click="isCollapse = !isCollapse"
          >
            <Fold v-if="!isCollapse" />
            <Expand v-else />
          </el-icon>
        </div>
        <div class="header-right">
          <LanguageSwitcher />
        </div>
      </el-header>

      <el-main class="main">
        <router-view v-slot="{ Component }">
          <keep-alive :include="['home', 'users', 'searchTasks', 'messageTasks', 'configs']">
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  HomeFilled,
  UserFilled,
  Search,
  Message,
  Setting,
  Fold,
  Expand
} from '@element-plus/icons-vue'
import LanguageSwitcher from './components/LanguageSwitcher.vue'

const route = useRoute()
const isCollapse = ref(false)
</script>

<style scoped>
.app-container {
  height: 100vh;
}

.aside {
  background-color: #304156;
  color: #fff;
  transition: width 0.3s;
  display: flex;
  flex-direction: column;
}

.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #2b2f3a;
  color: #fff;
  font-size: 20px;
  font-weight: bold;
  padding: 0 20px;
}

.logo span {
  white-space: nowrap;
}

.el-menu-vertical {
  border-right: none;
  background-color: #304156;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.flex-spacer {
  flex: 1;
}

.el-menu-vertical :deep(.el-menu-item) {
  color: #bfcbd9;
}

.el-menu-vertical :deep(.el-menu-item.is-active) {
  color: #409eff;
  background-color: #263445;
}

.el-menu-vertical :deep(.el-menu-item:hover) {
  color: #fff;
  background-color: #263445;
}

.header {
  background-color: #fff;
  border-bottom: 1px solid #dcdfe6;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
}

.header-left {
  display: flex;
  align-items: center;
}

.header-right {
  display: flex;
  align-items: center;
}

.collapse-btn {
  font-size: 20px;
  cursor: pointer;
  color: #606266;
}

.main {
  background-color: #f0f2f5;
  padding: 20px;
}
</style>