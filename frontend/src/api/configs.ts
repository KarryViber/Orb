import request from '@/utils/request'
import { ElMessage } from 'element-plus'

export interface Config {
  key: string
  value: string | null
  description: string | null
}

export interface ConfigUpdate {
  value: string
  description?: string
}

const CONFIG_STORAGE_KEY = 'sns_web_configs'

// 从本地存储获取所有配置
export const getLocalConfigs = (): Config[] => {
  try {
    const configsStr = localStorage.getItem(CONFIG_STORAGE_KEY)
    if (!configsStr) {
      return []
    }
    const configs = JSON.parse(configsStr)
    console.log('[getLocalConfigs] 从本地存储获取配置:', configs)
    return configs
  } catch (error) {
    console.error('获取本地配置失败:', error)
    return []
  }
}

// 保存配置到本地存储
const saveLocalConfigs = (configs: Config[]) => {
  try {
    console.log('[saveLocalConfigs] 保存配置到本地存储:', configs)
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(configs))
  } catch (error) {
    console.error('保存配置到本地存储失败:', error)
  }
}

// 获取所有配置
export const getConfigs = async (): Promise<Config[]> => {
  try {
    // 从后端获取配置
    const response = await request.get('/api/configs')
    const configs = response.data
    console.log('[getConfigs] 从后端获取配置:', configs)
    
    // 保存到本地存储
    saveLocalConfigs(configs)
    return configs
  } catch (error) {
    console.error('获取配置失败:', error)
    // 如果后端获取失败，返回本地存储的配置
    return getLocalConfigs()
  }
}

// 获取单个配置
export const getConfig = async (key: string): Promise<Config | null> => {
  try {
    // 从后端获取配置
    const response = await request.get(`/api/configs/${key}`)
    const config = response.data
    console.log(`[getConfig] 获取配置 ${key}:`, config)
    
    // 更新本地存储
    const configs = getLocalConfigs()
    const index = configs.findIndex(c => c.key === key)
    if (index >= 0) {
      configs[index] = config
    } else {
      configs.push(config)
    }
    saveLocalConfigs(configs)
    
    return config
  } catch (error) {
    console.error(`获取配置 ${key} 失败:`, error)
    // 如果后端获取失败，返回本地存储的配置
    const configs = getLocalConfigs()
    return configs.find(c => c.key === key) || null
  }
}

// 更新配置
export const updateConfig = async (key: string, data: ConfigUpdate): Promise<Config | null> => {
  try {
    console.log(`[updateConfig] 正在更新配置 ${key}:`, data)
    
    // 发送到后端
    const response = await request.put(`/api/configs/${key}`, data)
    const config = response.data
    console.log(`[updateConfig] 后端更新成功:`, config)
    
    // 更新本地存储
    let configs = getLocalConfigs()
    const configIndex = configs.findIndex(c => c.key === key)
    
    const newConfig: Config = {
      key,
      value: data.value,
      description: data.description || null
    }

    if (configIndex >= 0) {
      configs[configIndex] = newConfig
    } else {
      configs.push(newConfig)
    }

    saveLocalConfigs(configs)
    console.log('[updateConfig] 本地存储更新成功')
    
    return newConfig
  } catch (error) {
    console.error('更新配置失败:', error)
    ElMessage.error('更新配置失败')
    return null
  }
}

// 删除配置
export const deleteConfig = async (key: string): Promise<boolean> => {
  try {
    // 从后端删除
    await request.delete(`/api/configs/${key}`)
    
    // 从本地存储删除
    let configs = getLocalConfigs()
    configs = configs.filter(config => config.key !== key)
    saveLocalConfigs(configs)
    
    ElMessage.success('删除配置成功')
    return true
  } catch (error) {
    console.error('删除配置失败:', error)
    ElMessage.error('删除配置失败')
    return false
  }
}

// 获取配置值（用于请求拦截器）
export const getConfigValue = (key: string): string | null => {
  const configs = getLocalConfigs()
  const config = configs.find(c => c.key === key)
  console.log(`[getConfigValue] 获取配置值 ${key}:`, config?.value || null)
  return config?.value || null
} 