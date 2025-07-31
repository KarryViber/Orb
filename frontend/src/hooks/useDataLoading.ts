import { ref } from 'vue'
import { ElMessage } from 'element-plus'

export const useDataLoading = () => {
  const loading = ref(false)
  const error = ref<Error | null>(null)
  
  const withLoading = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    loading.value = true
    error.value = null
    try {
      const result = await fn()
      return result
    } catch (e) {
      error.value = e as Error
      ElMessage.error('操作失败，请稍后重试')
      return null
    } finally {
      loading.value = false
    }
  }
  
  return { loading, error, withLoading }
} 