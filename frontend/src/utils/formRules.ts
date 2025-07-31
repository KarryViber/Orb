import type { FormRules } from 'element-plus'

export const formRules = {
  required: (message: string) => ({ 
    required: true, 
    message, 
    trigger: 'blur' 
  }),
  
  length: (min: number, max: number) => ({
    min,
    max,
    message: `长度在 ${min} 到 ${max} 个字符`,
    trigger: 'blur'
  }),
  
  number: (min: number, max: number) => ({
    type: 'number',
    min,
    max,
    message: `数值范围在 ${min} 到 ${max} 之间`,
    trigger: 'blur'
  }),
  
  email: () => ({
    type: 'email',
    message: '请输入正确的邮箱地址',
    trigger: ['blur', 'change']
  }),
  
  url: () => ({
    type: 'url',
    message: '请输入正确的URL地址',
    trigger: ['blur', 'change']
  }),
  
  custom: (validator: (rule: any, value: any, callback: any) => void) => ({
    validator,
    trigger: 'change'
  })
}

// 创建通用的表单规则集合
export const createRules = (rules: Record<string, any[]>): FormRules => {
  const formRules: FormRules = {}
  
  for (const [field, ruleList] of Object.entries(rules)) {
    formRules[field] = ruleList
  }
  
  return formRules
} 