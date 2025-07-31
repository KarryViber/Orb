<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import type { InputInstance } from 'element-plus'
import { Platform } from '@/types/common'
import searchTaskService from '@/services/searchTasks'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'success', task: any): void
}>()

// 对话框状态
const dialogVisible = ref(props.modelValue)
const loading = ref(false)
const formRef = ref<FormInstance>()

// 新增的关键词输入相关变量
const inputValue = ref('')
const inputVisible = ref(false)
const inputRef = ref<InputInstance>()

// 表单数据
const form = ref({
  name: '',
  platform: Platform.INSTAGRAM,
  keywords: [] as string[],
  min_followers: undefined as number | undefined,
  max_followers: undefined as number | undefined,
  is_verified: undefined as boolean | undefined,
  is_private: undefined as boolean | undefined,
  is_business: undefined as boolean | undefined,
  results_limit: 1000, // 默认每个hashtag获取1000条帖子
  // Twitter特有参数
  language: undefined as string | undefined,
  min_retweets: undefined as number | undefined,
  min_likes: undefined as number | undefined,
  min_replies: undefined as number | undefined,
  start_date: undefined as string | undefined,
  end_date: undefined as string | undefined
})

// 表单验证规则
const rules = {
  name: [
    { required: true, message: t('search.form.nameRule'), trigger: 'blur' },
    { min: 2, max: 50, message: t('common.lengthLimit', { min: 2, max: 50 }), trigger: 'blur' }
  ],
  platform: [
    { required: true, message: t('common.platformRule'), trigger: 'change' }
  ],
  keywords: [
    { required: true, message: t('search.form.keywordsRule'), trigger: 'change' },
    { type: 'array', min: 1, message: t('search.form.keywordsMinRule'), trigger: 'change' }
  ],
  results_limit: [
    { required: true, message: t('search.form.limitRule'), trigger: 'blur' },
    { type: 'number', min: 20, max: 10000, message: t('search.form.limitRangeRule', { min: 20, max: 10000 }), trigger: 'blur' }
  ],
  // Twitter特有参数验证
  language: [
    { required: false, message: t('search.twitter.languageRule'), trigger: 'change' }
  ],
  min_retweets: [
    { type: 'number', min: 0, message: t('common.minValueRule', { min: 0 }), trigger: 'blur' }
  ],
  min_likes: [
    { type: 'number', min: 0, message: t('common.minValueRule', { min: 0 }), trigger: 'blur' }
  ],
  min_replies: [
    { type: 'number', min: 0, message: t('common.minValueRule', { min: 0 }), trigger: 'blur' }
  ]
}

// 语言选项
const languageOptions = computed(() => [
  { value: 'en', label: t('search.twitter.languages.en') },
  { value: 'es', label: t('search.twitter.languages.es') },
  { value: 'fr', label: t('search.twitter.languages.fr') },
  { value: 'de', label: t('search.twitter.languages.de') },
  { value: 'it', label: t('search.twitter.languages.it') },
  { value: 'pt', label: t('search.twitter.languages.pt') },
  { value: 'ru', label: t('search.twitter.languages.ru') },
  { value: 'ja', label: t('search.twitter.languages.ja') },
  { value: 'ko', label: t('search.twitter.languages.ko') },
  { value: 'zh', label: t('search.twitter.languages.zh') }
])

// 是否显示Twitter特有参数
const showTwitterParams = ref(false)

// 监听对话框可见性
watch(() => props.modelValue, (newVal: boolean) => {
  dialogVisible.value = newVal
})

watch(() => dialogVisible.value, (newVal: boolean) => {
  emit('update:modelValue', newVal)
})

// 监听平台变化
watch(() => form.value.platform, (newPlatform) => {
  showTwitterParams.value = newPlatform === Platform.TWITTER
})

// 监听日期变化，验证日期范围
watch([() => form.value.start_date, () => form.value.end_date], ([start, end]) => {
  if (start && end && new Date(start) > new Date(end)) {
    ElMessage.warning(t('search.twitter.dateRangeRule'))
    form.value.end_date = undefined
  }
})

// 显示输入框
const showInput = () => {
  inputVisible.value = true
  nextTick(() => {
    inputRef.value?.focus()
  })
}

// 处理输入确认
const handleInputConfirm = () => {
  if (inputValue.value) {
    const keyword = inputValue.value.trim()
    if (keyword && !form.value.keywords.includes(keyword)) {
      form.value.keywords.push(keyword)
    }
  }
  inputVisible.value = false
  inputValue.value = ''
}

// 移除关键词
const removeKeyword = (keyword: string) => {
  form.value.keywords = form.value.keywords.filter(item => item !== keyword)
}

// 提交表单
const handleSubmit = async () => {
  if (!formRef.value) return
  
  try {
    await formRef.value.validate()
    loading.value = true
    
    // 构造搜索参数
    const searchParams = {
      keywords: form.value.keywords,
      min_followers: form.value.min_followers,
      max_followers: form.value.max_followers,
      is_verified: form.value.is_verified,
      is_private: form.value.is_private,
      is_business: form.value.is_business
    }

    // 如果是Twitter平台，添加特有参数
    if (form.value.platform === Platform.TWITTER) {
      Object.assign(searchParams, {
        language: form.value.language,
        min_retweets: form.value.min_retweets,
        min_likes: form.value.min_likes,
        min_replies: form.value.min_replies,
        start_date: form.value.start_date,
        end_date: form.value.end_date
      })
    }
    
    // 创建任务
    const task = await searchTaskService.createTask({
      name: form.value.name,
      platform: form.value.platform,
      search_params: searchParams,
      results_limit: form.value.results_limit
    })
    
    ElMessage.success(t('message.createSuccess'))
    dialogVisible.value = false
    emit('success', task)
  } catch (error) {
    console.error('创建搜索任务失败:', error)
    ElMessage.error(t('message.createFailed'))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="t('search.createTask')"
    width="600px"
    :close-on-click-modal="false"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="120px"
    >
      <el-form-item :label="t('task.taskName')" prop="name">
        <el-input 
          v-model="form.name" 
          :placeholder="t('search.form.namePlaceholder')" 
        />
      </el-form-item>

      <el-form-item :label="t('common.platform')" prop="platform">
        <el-select 
          v-model="form.platform" 
          style="width: 100%"
        >
          <el-option label="Instagram" :value="Platform.INSTAGRAM" />
          <el-option label="Twitter" :value="Platform.TWITTER" />
        </el-select>
      </el-form-item>

      <el-form-item :label="t('search.keywords')" prop="keywords">
        <div class="keywords-input-container">
          <el-tag
            v-for="keyword in form.keywords"
            :key="keyword"
            class="keyword-tag"
            closable
            @close="removeKeyword(keyword)"
          >
            {{ keyword }}
          </el-tag>
          <el-input
            v-if="inputVisible"
            ref="inputRef"
            v-model="inputValue"
            class="keyword-input"
            size="small"
            @keyup.enter="handleInputConfirm"
            @blur="handleInputConfirm"
            :placeholder="t('search.form.keywordsPlaceholder')"
          />
          <el-button
            v-else
            class="button-new-keyword"
            size="small"
            @click="showInput"
          >
            {{ t('search.addKeyword') }}
          </el-button>
        </div>
        <div class="form-help">{{ t('search.form.keywordsHelp') }}</div>
      </el-form-item>

      <el-form-item :label="t('search.resultsLimit')" prop="results_limit">
        <el-input-number
          v-model="form.results_limit"
          :min="20"
          :max="10000"
          :step="20"
          style="width: 200px"
        />
        <div class="form-help">
          {{ t('search.form.limitHelp', { min: 20, max: 10000 }) }}
        </div>
      </el-form-item>

      <el-divider>{{ t('search.filterConditions') }}</el-divider>

      <el-form-item :label="t('search.followersRange')">
        <el-col :span="11">
          <el-input-number
            v-model="form.min_followers"
            :min="0"
            :placeholder="t('search.form.minFollowers')"
          />
        </el-col>
        <el-col :span="2" style="text-align: center">-</el-col>
        <el-col :span="11">
          <el-input-number
            v-model="form.max_followers"
            :min="0"
            :placeholder="t('search.form.maxFollowers')"
          />
        </el-col>
      </el-form-item>

      <el-form-item :label="t('search.accountType')">
        <el-checkbox v-model="form.is_verified">{{ t('search.verifiedAccount') }}</el-checkbox>
        <template v-if="form.platform === Platform.INSTAGRAM">
          <el-checkbox v-model="form.is_private">{{ t('search.privateAccount') }}</el-checkbox>
          <el-checkbox v-model="form.is_business">{{ t('search.businessAccount') }}</el-checkbox>
        </template>
      </el-form-item>

      <!-- Twitter特有参数 -->
      <template v-if="showTwitterParams">
        <el-divider>{{ t('search.twitter.engagement') }}</el-divider>
        
        <el-form-item :label="t('search.twitter.language')" prop="language">
          <el-select v-model="form.language" style="width: 100%">
            <el-option
              v-for="option in languageOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item :label="t('search.twitter.engagement')">
          <el-row :gutter="20">
            <el-col :span="8">
              <el-input-number
                v-model="form.min_retweets"
                :min="0"
                :placeholder="t('search.twitter.minRetweets')"
              />
            </el-col>
            <el-col :span="8">
              <el-input-number
                v-model="form.min_likes"
                :min="0"
                :placeholder="t('search.twitter.minLikes')"
              />
            </el-col>
            <el-col :span="8">
              <el-input-number
                v-model="form.min_replies"
                :min="0"
                :placeholder="t('search.twitter.minReplies')"
              />
            </el-col>
          </el-row>
        </el-form-item>

        <el-form-item :label="t('search.twitter.dateRange')">
          <el-date-picker
            v-model="form.start_date"
            type="date"
            :placeholder="t('search.twitter.startDate')"
            style="width: 180px"
          />
          <span style="margin: 0 10px">-</span>
          <el-date-picker
            v-model="form.end_date"
            type="date"
            :placeholder="t('search.twitter.endDate')"
            style="width: 180px"
          />
        </el-form-item>
      </template>
    </el-form>

    <template #footer>
      <el-button @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
      <el-button
        type="primary"
        :loading="loading"
        @click="handleSubmit"
      >
        {{ t('common.confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.form-help {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
  line-height: 1.4;
}

.keywords-input-container {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-height: 32px;
  padding: 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
}

.keyword-tag {
  margin-right: 6px;
  margin-bottom: 6px;
}

.keyword-input {
  width: 120px;
  margin-right: 6px;
  margin-bottom: 6px;
  flex-shrink: 0;
}

.button-new-keyword {
  margin-bottom: 6px;
  height: 28px;
  padding: 0 10px;
}

.post-matched-keywords {
    margin: 8px 0;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.matched-keywords-label {
    color: #606266;
    font-size: 13px;
}

.matched-keyword-tag {
    margin: 2px;
}
</style> 