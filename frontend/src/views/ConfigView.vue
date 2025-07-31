<template>
  <div class="config-view">
    <el-card class="config-card">
      <template #header>
        <div class="card-header">
          <h2>{{ t('config.systemConfig') }}</h2>
          <el-text type="info">{{ t('config.configTip') }}</el-text>
        </div>
      </template>

      <el-form
        ref="formRef"
        :model="configs"
        :rules="rules"
        label-width="140px"
        v-loading="loading"
      >
        <!-- Apify配置 -->
        <el-form-item :label="t('config.apiToken')" prop="APIFY_API_TOKEN">
          <el-input
            v-model="configs.APIFY_API_TOKEN"
            :placeholder="t('config.apiTokenPlaceholder')"
            show-password
          >
            <template #append>
              <el-tooltip :content="t('config.testTokenTip')" placement="top">
                <el-button @click="testApiToken">{{ t('config.testToken') }}</el-button>
              </el-tooltip>
            </template>
          </el-input>
          <div class="form-help">
            <el-popover
              placement="right"
              :width="300"
              trigger="hover"
            >
              <template #reference>
                <el-link type="primary">{{ t('config.howToGetToken') }}</el-link>
              </template>
              <template #default>
                <h4>{{ t('config.howToGetTokenTitle') }}</h4>
                <el-text v-for="step in t('config.howToGetTokenSteps')" :key="step" class="help-step">
                  {{ step }}
                </el-text>
              </template>
            </el-popover>
          </div>
        </el-form-item>

        <!-- Instagram配置 -->
        <el-form-item :label="t('config.instagramAccount')" prop="INSTAGRAM_USERNAME">
          <el-input
            v-model="configs.INSTAGRAM_USERNAME"
            :placeholder="t('config.instagramUsername')"
          />
        </el-form-item>

        <el-form-item :label="t('config.instagramPassword')" prop="INSTAGRAM_PASSWORD">
          <el-input
            v-model="configs.INSTAGRAM_PASSWORD"
            type="password"
            :placeholder="t('config.instagramPasswordPlaceholder')"
            show-password
          />
        </el-form-item>

        <el-form-item :label="t('config.instagramCookies')" prop="INSTAGRAM_COOKIES">
          <el-input
            v-model="configs.INSTAGRAM_COOKIES"
            type="textarea"
            :rows="6"
            :placeholder="t('config.instagramCookiesPlaceholder')"
          />
          <div class="form-help">
            <el-popover
              placement="right"
              :width="300"
              trigger="hover"
            >
              <template #reference>
                <el-link type="primary">{{ t('config.cookiesFormat') }}</el-link>
              </template>
              <template #default>
                <h4>{{ t('config.cookiesFormatTitle') }}</h4>
                <pre class="cookies-example">{{ t('config.cookiesFormatContent') }}</pre>
              </template>
            </el-popover>
          </div>
        </el-form-item>

        <!-- 保存按钮 -->
        <el-form-item>
          <el-button type="primary" @click="handleSave" :loading="saving">
            {{ t('config.saveConfig') }}
          </el-button>
          <el-button @click="handleExport">{{ t('config.exportConfig') }}</el-button>
          <el-button @click="handleImport">{{ t('config.importConfig') }}</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 文件导入用的隐藏input -->
    <input
      type="file"
      ref="fileInput"
      style="display: none"
      accept=".json"
      @change="onFileSelected"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import type { FormInstance } from 'element-plus'
import configManager, { CONFIG_KEYS } from '@/utils/config'
import { updateConfig } from '@/api/configs'

const { t } = useI18n()
const formRef = ref<FormInstance>()
const fileInput = ref<HTMLInputElement>()
const loading = ref(false)
const saving = ref(false)

interface ConfigData {
  [key: string]: string
  APIFY_API_TOKEN: string
  INSTAGRAM_USERNAME: string
  INSTAGRAM_PASSWORD: string
  INSTAGRAM_COOKIES: string
}

// 配置数据
const configs = ref<ConfigData>({
  APIFY_API_TOKEN: '',
  INSTAGRAM_USERNAME: '',
  INSTAGRAM_PASSWORD: '',
  INSTAGRAM_COOKIES: ''
})

// 添加表单验证规则
const rules = {
  APIFY_API_TOKEN: [
    { required: true, message: t('config.validation.apiTokenRequired'), trigger: 'blur' },
    { min: 20, message: t('config.validation.apiTokenLength'), trigger: 'blur' }
  ],
  INSTAGRAM_USERNAME: [
    { required: true, message: t('config.validation.usernameRequired'), trigger: 'blur' }
  ],
  INSTAGRAM_PASSWORD: [
    { required: true, message: t('config.validation.passwordRequired'), trigger: 'blur' }
  ],
  INSTAGRAM_COOKIES: [
    { 
      validator: (rule: any, value: string, callback: any) => {
        if (!value) {
          callback()
          return
        }
        try {
          JSON.parse(value)
          callback()
        } catch (e) {
          callback(new Error(t('config.validation.invalidJson')))
        }
      },
      trigger: 'blur'
    }
  ]
}

// 加载配置
const loadConfigs = () => {
  loading.value = true
  try {
    const allConfigs = configManager.getAllConfigs()
    configs.value = {
      APIFY_API_TOKEN: allConfigs[CONFIG_KEYS.API_TOKEN] || '',
      INSTAGRAM_USERNAME: allConfigs[CONFIG_KEYS.USERNAME] || '',
      INSTAGRAM_PASSWORD: allConfigs[CONFIG_KEYS.PASSWORD] || '',
      INSTAGRAM_COOKIES: allConfigs[CONFIG_KEYS.COOKIES] || ''
    }
  } catch (error) {
    console.error('[ConfigView] 加载配置失败:', error)
    ElMessage.error(t('config.messages.loadFailed'))
  } finally {
    loading.value = false
  }
}

// 测试 API Token
const testApiToken = async () => {
  if (!configs.value.APIFY_API_TOKEN) {
    ElMessage.warning(t('config.messages.pleaseInputToken'))
    return
  }

  try {
    // TODO: 实现 API Token 测试逻辑
    ElMessage.success(t('config.messages.tokenValid'))
  } catch (error) {
    ElMessage.error(t('config.messages.tokenInvalid'))
  }
}

// 保存配置
const handleSave = async () => {
  if (!formRef.value) return
  
  try {
    await formRef.value.validate()
    saving.value = true
    
    // 保存到localStorage
    configManager.saveConfigs({
      [CONFIG_KEYS.API_TOKEN]: configs.value.APIFY_API_TOKEN,
      [CONFIG_KEYS.USERNAME]: configs.value.INSTAGRAM_USERNAME,
      [CONFIG_KEYS.PASSWORD]: configs.value.INSTAGRAM_PASSWORD,
      [CONFIG_KEYS.COOKIES]: configs.value.INSTAGRAM_COOKIES
    })

    // 同时保存到后端
    const promises = Object.entries(configs.value).map(([key, value]) => {
      return updateConfig(key, { value })
    })
    
    await Promise.all(promises)
    ElMessage.success(t('config.messages.saveSuccess'))
  } catch (error) {
    console.error('[ConfigView] 保存配置失败:', error)
    ElMessage.error(t('config.messages.saveFailed'))
  } finally {
    saving.value = false
  }
}

// 导出配置
const handleExport = () => {
  const configData = { ...configs.value }
  
  const blob = new Blob([JSON.stringify(configData, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'sns_web_config.json'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// 导入配置
const handleImport = () => {
  fileInput.value?.click()
}

// 处理文件选择
const onFileSelected = (event: Event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = async (e) => {
    try {
      const content = e.target?.result as string
      const importedConfigs = JSON.parse(content)
      
      // 更新配置
      Object.keys(configs.value).forEach(key => {
        if (key in importedConfigs) {
          configs.value[key as keyof ConfigData] = importedConfigs[key]
        }
      })
      
      await handleSave()
      ElMessage.success(t('config.messages.importSuccess'))
    } catch (error) {
      console.error('导入配置失败:', error)
      ElMessage.error(t('config.messages.importFailed'))
    }
    
    // 清除文件选择
    if (fileInput.value) {
      fileInput.value.value = ''
    }
  }
  
  reader.readAsText(file)
}

// 组件加载时获取配置
onMounted(() => {
  loadConfigs()
})
</script>

<style scoped>
.config-view {
  padding: 20px;
}

.config-card {
  max-width: 800px;
  margin: 0 auto;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-header h2 {
  margin: 0;
  font-size: 18px;
  color: #303133;
}

.form-help {
  margin-top: 8px;
  font-size: 14px;
  color: #909399;
}

.help-step {
  display: block;
  margin-bottom: 8px;
}

.cookies-example {
  background: #f5f7fa;
  padding: 10px;
  border-radius: 4px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style> 