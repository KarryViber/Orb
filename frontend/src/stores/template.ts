import { defineStore } from 'pinia'
import request from '@/utils/request'
import type { Template } from '@/types/template'

export const useTemplateStore = defineStore('template', {
  state: () => ({
    templates: [] as Template[],
    loading: false,
    error: null as string | null
  }),

  actions: {
    async fetchTemplates() {
      this.loading = true
      this.error = null
      try {
        const response = await request({
          url: '/api/templates',
          method: 'get'
        })
        this.templates = response.data
        return this.templates
      } catch (error: any) {
        this.error = error.message
        throw error
      } finally {
        this.loading = false
      }
    }
  }
}) 