import { defineStore } from 'pinia'
import request from '@/utils/request'
import type { User } from '@/types/user'

export const useUserStore = defineStore('user', {
  state: () => ({
    users: [] as User[],
    loading: false,
    error: null as string | null
  }),

  actions: {
    async fetchUsers() {
      this.loading = true
      this.error = null
      try {
        const response = await request({
          url: '/api/users',
          method: 'get'
        })
        this.users = response.data
        return this.users
      } catch (error: any) {
        this.error = error.message
        throw error
      } finally {
        this.loading = false
      }
    }
  }
}) 