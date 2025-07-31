<template>
  <el-card class="toolbar-card">
    <el-row :gutter="20">
      <!-- 搜索框 -->
      <el-col :span="6">
        <el-input
          v-model="searchModel"
          :placeholder="searchPlaceholder || t('user.filter.searchByNameDisplay')"
          clearable
          @keyup.enter="handleSearch"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
      </el-col>

      <!-- 平台选择器 -->
      <el-col :span="4" v-if="showPlatformSelect">
        <el-select
          v-model="platformModel"
          :placeholder="t('user.filter.selectPlatform')"
          clearable
        >
          <el-option label="Instagram" value="instagram" />
          <el-option label="Twitter" value="twitter" />
          <el-option label="Facebook" value="facebook" />
        </el-select>
      </el-col>

      <!-- 标签选择器 -->
      <el-col :span="4" v-if="showTagSelect">
        <div class="tag-filter">
          <el-select
            v-model="tagsModel"
            multiple
            collapse-tags
            :placeholder="t('user.filter.selectTags')"
            clearable
            style="width: 100%"
            @change="handleTagsChange"
          >
            <el-option
              v-for="tag in tagOptions"
              :key="tag.value"
              :label="tag.label"
              :value="tag.value"
            >
              <span>{{ tag.label }}</span>
            </el-option>
          </el-select>
          <el-radio-group 
            v-model="tagLogic" 
            size="small" 
            class="tag-logic"
            @change="handleTagLogicChange"
          >
            <el-radio-button label="or">OR</el-radio-button>
            <el-radio-button label="and">AND</el-radio-button>
          </el-radio-group>
        </div>
      </el-col>

      <!-- 操作按钮 -->
      <el-col :span="showTagSelect ? 10 : 14" class="text-right">
        <el-button-group>
          <el-button type="primary" @click="$emit('create')">
            <el-icon><Plus /></el-icon>{{ createButtonText || t('user.filter.createUser') }}
          </el-button>
          <slot name="additional-buttons"></slot>
        </el-button-group>
      </el-col>
    </el-row>
  </el-card>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Search, Plus } from '@element-plus/icons-vue'

interface TagOption {
  value: string
  label: string
}

interface Props {
  searchPlaceholder?: string
  createButtonText?: string
  showPlatformSelect?: boolean
  showTagSelect?: boolean
  tagOptions: TagOption[]
  search?: string
  platform?: string
  tags?: string[]
  tagLogic?: 'or' | 'and'
}

const props = withDefaults(defineProps<Props>(), {
  searchPlaceholder: '',
  createButtonText: '',
  showPlatformSelect: true,
  showTagSelect: false,
  tagOptions: () => [],
  search: '',
  platform: '',
  tags: () => [],
  tagLogic: 'or'
})

const emit = defineEmits<{
  (e: 'update:search', value: string): void
  (e: 'update:platform', value: string): void
  (e: 'update:tags', value: string[]): void
  (e: 'update:tagLogic', value: 'or' | 'and'): void
  (e: 'search'): void
  (e: 'create'): void
}>()

const { t } = useI18n()

// 使用ref来跟踪内部状态
const searchModel = ref(props.search)
const platformModel = ref(props.platform)
const tagsModel = ref<string[]>(props.tags || [])
const tagLogic = ref<'or' | 'and'>(props.tagLogic || 'or')

// 监听props变化
watch(() => props.search, (val) => {
  if (val !== searchModel.value) {
    searchModel.value = val
  }
})

watch(() => props.platform, (val) => {
  if (val !== platformModel.value) {
    platformModel.value = val
  }
})

watch(() => props.tags, (val) => {
  if (JSON.stringify(val) !== JSON.stringify(tagsModel.value)) {
    console.log('标签props变化:', val)
    tagsModel.value = val || []
  }
}, { deep: true })

watch(() => props.tagLogic, (val) => {
  if (val !== tagLogic.value) {
    tagLogic.value = val as 'or' | 'and'
  }
})

// 监听内部状态变化并触发事件
watch(searchModel, (val) => {
  console.log('搜索关键词变更:', val)
  emit('update:search', val)
})

watch(platformModel, (val) => {
  console.log('平台选择变更:', val)
  emit('update:platform', val || '')  // 确保空值时传递空字符串
})

watch(tagsModel, (val) => {
  console.log('标签选择变更:', val)
  emit('update:tags', val)
}, { deep: true })

watch(tagLogic, (val) => {
  console.log('标签逻辑变更:', val)
  emit('update:tagLogic', val)
})

// 添加调试日志
onMounted(() => {
  console.log('DataTableToolbar mounted')
  console.log('初始标签选项:', props.tagOptions)
  console.log('初始选中标签:', tagsModel.value)
})

watch(() => props.tagOptions, (val) => {
  console.log('标签选项更新:', val)
  if (val && val.length > 0) {
    // 确保每个标签都有正确的格式
    const formattedTags = val.map(tag => {
      if (typeof tag === 'string') {
        return { value: tag, label: tag }
      }
      return tag
    })
    console.log('格式化后的标签选项:', formattedTags)
  }
}, { deep: true, immediate: true })

const handleTagsChange = (val: string[]) => {
  console.log('标签选择变更:', val)
  tagsModel.value = val
  emit('update:tags', val)
}

const handleTagLogicChange = (val: 'or' | 'and') => {
  console.log('标签逻辑变更:', val)
  tagLogic.value = val
  emit('update:tagLogic', val)
}

const handleSearch = () => {
  console.log('执行搜索，当前条件:', {
    search: searchModel.value,
    platform: platformModel.value,
    tags: tagsModel.value,
    tagLogic: tagLogic.value
  })
  emit('search')
}
</script>

<style scoped>
.toolbar-card {
  margin-bottom: 16px;
}

.text-right {
  text-align: right;
}

.tag-filter {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tag-logic {
  display: flex;
  justify-content: center;
}

:deep(.el-radio-button__inner) {
  padding: 4px 12px;
}
</style>
