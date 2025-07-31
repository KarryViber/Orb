import axios from 'axios'
import { ElMessage } from 'element-plus'
import configManager from './config'

// 扩展配置类型
interface RetryConfig {
  retry?: number
  retryDelay?: number
  __retryCount?: number
}

// 创建axios实例
const request = axios.create({
  // 本地开发时使用8081端口，生产环境使用相对路径（通过nginx代理）
  baseURL: import.meta.env.DEV ? 'http://localhost:8081' : '/api',
  timeout: 30000 // 请求超时时间
})

// 添加重试配置到service实例
const retryConfig: RetryConfig = {
  retry: 3,
  retryDelay: 1000
}

Object.assign(request.defaults, retryConfig)

// 请求拦截器
request.interceptors.request.use(
  config => {
    // 从配置管理器获取token
    const apiToken = configManager.getApiToken()
    if (apiToken) {
      config.headers['X-Apify-Token'] = apiToken
      console.log('[Request Interceptor] Added token to headers')
    }
    
    // 添加时间戳防止缓存
    if (config.method === 'get') {
      config.params = { ...config.params, _t: Date.now() }
    }
    
    // 添加token
    const token = localStorage.getItem('token')
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`
    }
    
    // 打印请求信息
    console.log('[Request]', {
      method: config.method,
      url: config.url,
      data: config.data,
      params: config.params
    })
    
    return config
  },
  error => {
    console.error('[Request Error]', error)
    return Promise.reject(error)
  }
)

// 响应拦截器
request.interceptors.response.use(
  response => {
    // 打印响应信息
    console.log('[Response]', {
      status: response.status,
      data: response.data,
      headers: response.headers
    })
    
    // 如果响应成功，返回响应数据
    if (response.status === 200) {
      return response.data
    }
    
    // 处理其他状态码
    ElMessage.error(response.data?.message || '请求失败')
    return Promise.reject(new Error(response.data?.message || '请求失败'))
  },
  error => {
    // 打印详细错误信息
    console.error('[Response Error]', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      config: {
        method: error.config?.method,
        url: error.config?.url,
        data: error.config?.data,
        params: error.config?.params
      }
    })
    
    if (error.response) {
      // 服务器返回错误状态码
      const message = error.response.data?.detail || error.response.data?.message || '请求失败'
      ElMessage.error(message)
    } else if (error.request) {
      // 请求发出但没有收到响应
      ElMessage.error('服务器无响应')
    } else {
      // 请求配置出错
      ElMessage.error('请求配置错误')
    }
    return Promise.reject(error)
  }
)

export default request 