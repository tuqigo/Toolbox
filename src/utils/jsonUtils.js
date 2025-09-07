// JSON 判断工具函数
// 统一的严格模式JSON判断逻辑

/**
 * 严格模式判断内容是否为有效的JSON对象或数组
 * @param {string} content - 要判断的内容
 * @returns {boolean} - 是否为有效JSON
 */
function isValidJson(content) {
  const trimmed = (content || '').trim();
  if (!trimmed) return false;
  
  // 必须以 { 或 [ 开头，以 } 或 ] 结尾
  const startsWithJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  const endsWithJson = trimmed.endsWith('}') || trimmed.endsWith(']');
  if (!startsWithJson || !endsWithJson) return false;
  
  // 长度检查 - 至少要有基本的JSON结构
  if (trimmed.length < 2) return false;
  
  // 尝试解析JSON
  try {
    const parsed = JSON.parse(trimmed);
    
    // 必须是对象或数组
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    
    // 严格模式：只要能正确解析为对象或数组就认为是JSON
    return true;
    
  } catch (error) {
    return false;
  }
}

module.exports = { isValidJson };
