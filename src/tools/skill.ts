import type { SkillCatalog } from '../core/skills.js';
import type { Tool } from '../core/tool.js';

/**
 * 把 skill 的正文读进上下文。
 *
 * 这是"按需加载"里"按需"那一步。系统提示里只有名称和一句话说明,正文要模型自己
 * 点名换进来 —— 用不到的能力就不占位置。用不到的能力全都塞进每一次会话,代价是
 * 每一轮都在为它们付费,而且真正相关的那些会被淹掉。
 */
export function createSkillTool(catalog: SkillCatalog): Tool {
  return {
    spec: {
      name: 'skill',
      description: [
        '读入一个 skill 的完整正文,然后照着它做。',
        '系统提示里只列了名称与一句话说明,正文没在你的上下文里 —— ',
        '觉得某个 skill 对眼下这件事有用,就用它把正文取回来。',
        '取回来之后按里面写的步骤做,不要只当成参考资料。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要读入的 skill 名称,用系统提示里列的那个' },
        },
        required: ['name'],
      },
    },

    async run(input) {
      const { name } = (input ?? {}) as { name?: unknown };
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('skill 的 name 要是一个非空的名称');
      }

      return catalog.load(name.trim());
    },
  };
}
