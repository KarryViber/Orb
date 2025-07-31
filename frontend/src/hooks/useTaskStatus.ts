import { ref, onBeforeUnmount } from 'vue'

export const useTaskStatus = () => {
  const statusUpdateTimer = ref<number | null>(null)
  
  const startStatusUpdate = (callback: () => void, interval: number = 5000) => {
    // 先清除可能存在的定时器
    if (statusUpdateTimer.value) {
      clearInterval(statusUpdateTimer.value)
    }
    
    // 启动新的定时器
    statusUpdateTimer.value = window.setInterval(callback, interval)
  }
  
  const stopStatusUpdate = () => {
    if (statusUpdateTimer.value) {
      clearInterval(statusUpdateTimer.value)
      statusUpdateTimer.value = null
    }
  }
  
  onBeforeUnmount(() => {
    stopStatusUpdate()
  })
  
  return { startStatusUpdate, stopStatusUpdate }
} 