import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL;

export interface SearchTaskFilters {
    minFollowers?: number;
    maxFollowers?: number;
    isVerified?: boolean;
    isPrivate?: boolean;
}

export interface SearchTaskParams {
    platform: string;
    keywords: string;
    filters: SearchTaskFilters;
}

export interface SearchTask {
    id: number;
    name: string;
    platform: string;
    search_params: {
        keywords?: string[];
        location?: string[];
        min_followers?: number;
        max_followers?: number;
        min_following?: number;
        max_following?: number;
        min_posts?: number;
        max_posts?: number;
        is_verified?: boolean;
        is_private?: boolean;
        has_website?: boolean;
        category?: string;
    };
    status: 'pending' | 'processing' | 'completed' | 'failed';
    result_count: number;
    results_limit: number;
    is_completed: boolean;
    error_message?: string;
    created_at: string;
    completed_at?: string;
    type: string;
}

export interface SearchTaskListResponse {
    data: SearchTask[];
    total: number;
    page: number;
    page_size: number;
}

export const searchTaskService = {
    // 创建搜索任务
    async createTask(params: SearchTaskParams): Promise<SearchTask> {
        const response = await axios.post(`${API_URL}/search-tasks`, params);
        return response.data;
    },

    // 获取任务列表
    async getTasks(params?: { platform?: string; page?: number; pageSize?: number }): Promise<SearchTaskListResponse> {
        const { platform, page = 1, pageSize = 10 } = params || {};
        
        const response = await axios.get(`${API_URL}/search-tasks`, {
            params: {
                platform,
                page,
                pageSize
            }
        });
        return response.data;
    },

    // 获取任务详情
    async getTask(taskId: number): Promise<SearchTask> {
        const response = await axios.get(`${API_URL}/search-tasks/${taskId}`);
        return response.data;
    },

    // 删除任务
    async deleteTask(taskId: number): Promise<void> {
        await axios.delete(`${API_URL}/search-tasks/${taskId}`);
    },

    // 轮询任务状态
    async pollTaskStatus(taskId: number, callback: (task: SearchTask) => void, interval = 3000): Promise<void> {
        const checkStatus = async () => {
            const task = await this.getTask(taskId);
            callback(task);
            
            if (!task.is_completed && task.status !== 'failed') {
                setTimeout(checkStatus, interval);
            }
        };
        
        await checkStatus();
    }
}; 