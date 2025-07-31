// 配置键名常量
export const CONFIG_KEYS = {
  API_TOKEN: 'APIFY_API_TOKEN',
  COOKIES: 'INSTAGRAM_COOKIES',
  USERNAME: 'INSTAGRAM_USERNAME',
  PASSWORD: 'INSTAGRAM_PASSWORD'
} as const;

// 配置管理类
class ConfigManager {
  // 获取配置
  getConfig(key: string): string | null {
    return localStorage.getItem(key);
  }

  // 设置配置
  setConfig(key: string, value: string) {
    localStorage.setItem(key, value);
  }

  // 删除配置
  removeConfig(key: string) {
    localStorage.removeItem(key);
  }

  // 获取API Token
  getApiToken(): string | null {
    return this.getConfig(CONFIG_KEYS.API_TOKEN);
  }

  // 获取Cookies
  getCookies(): any[] | null {
    const cookiesStr = this.getConfig(CONFIG_KEYS.COOKIES);
    if (!cookiesStr) return null;
    try {
      // 尝试解析 JSON
      const cookies = JSON.parse(cookiesStr);
      
      // 如果已经是正确的数组格式，直接返回
      if (Array.isArray(cookies) && cookies.length > 0 && 'name' in cookies[0] && 'value' in cookies[0]) {
        return cookies;
      }
      
      // 如果是对象格式，转换为数组格式
      if (typeof cookies === 'object') {
        const baseExpires = Date.now() + 365 * 24 * 60 * 60 * 1000; // 一年后过期
        return Object.entries(cookies).map(([name, value]) => ({
          name,
          value: String(value),
          domain: ".instagram.com",
          path: "/",
          expires: baseExpires,
          httpOnly: true,
          secure: true
        }));
      }
      
      return null;
    } catch (error) {
      console.error('解析 Cookies 失败:', error);
      return null;
    }
  }

  // 获取所有配置
  getAllConfigs(): Record<string, string | null> {
    return Object.values(CONFIG_KEYS).reduce((configs, key) => {
      configs[key] = this.getConfig(key);
      return configs;
    }, {} as Record<string, string | null>);
  }

  // 批量保存配置
  saveConfigs(configs: Record<string, string>) {
    Object.entries(configs).forEach(([key, value]) => {
      this.setConfig(key, value);
    });
  }
}

export default new ConfigManager(); 