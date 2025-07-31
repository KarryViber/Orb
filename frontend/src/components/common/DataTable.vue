<template>
  <div class="data-table">
    <el-card class="list-card">
      <!-- 数据表格 -->
      <el-table
        v-loading="loading"
        :data="data"
        style="width: 100%"
        @selection-change="handleSelectionChange"
      >
        <!-- 多选列 -->
        <el-table-column
          v-if="showSelection"
          type="selection"
          width="55"
        />
        
        <!-- 动态列 -->
        <slot></slot>

        <!-- 操作列 -->
        <el-table-column
          v-if="showActions"
          label="操作"
          width="200"
          fixed="right"
        >
          <template #default="{ row }">
            <el-button-group>
              <el-button
                v-if="showEditButton"
                type="primary"
                link
                @click="$emit('edit', row)"
              >
                编辑
              </el-button>
              <el-button
                v-if="showDeleteButton"
                type="danger"
                link
                @click="$emit('delete', row)"
              >
                删除
              </el-button>
              <slot name="additional-actions" :row="row"></slot>
            </el-button-group>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <div class="pagination-container">
        <el-pagination
          :current-page="currentPage"
          :page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          layout="total, sizes, prev, pager, next"
          @size-change="$emit('size-change', $event)"
          @current-change="$emit('current-change', $event)"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'

const props = defineProps({
  data: {
    type: Array,
    required: true,
    default: () => []
  },
  loading: {
    type: Boolean,
    default: false
  },
  total: {
    type: Number,
    required: true
  },
  currentPage: {
    type: Number,
    required: true
  },
  pageSize: {
    type: Number,
    required: true
  },
  showSelection: {
    type: Boolean,
    default: false
  },
  showActions: {
    type: Boolean,
    default: true
  },
  showEditButton: {
    type: Boolean,
    default: true
  },
  showDeleteButton: {
    type: Boolean,
    default: true
  }
})

// 监听数据变化
watch(() => props.data, (newData) => {
  console.log('DataTable数据更新:', {
    data: newData,
    total: props.total,
    currentPage: props.currentPage,
    pageSize: props.pageSize
  })
}, { immediate: true })

const emit = defineEmits<{
  (e: 'selection-change', selection: any[]): void
  (e: 'current-change', page: number): void
  (e: 'size-change', size: number): void
  (e: 'edit', row: any): void
  (e: 'delete', row: any): void
}>()

// 处理选择变更
const handleSelectionChange = (selection: any[]) => {
  emit('selection-change', selection)
}
</script>

<style scoped>
.data-table {
  margin-top: 16px;
}

.pagination-container {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
