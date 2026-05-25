import TaskModel, { ITask } from "@chat/db/models/Task";

export type TaskPlanResult = {
    parentTaskId: string;
    subTaskIds: string[];
    planned: boolean;
};

export class TaskPlanner {
    // Deprecated: planning/action decomposition moved to agent-runner.
    async planTask(taskId: string): Promise<TaskPlanResult> {
        const task = await TaskModel.findById(taskId);
        if (!task) {
            throw new Error(`Task not found: ${taskId}`);
        }

        return {
            parentTaskId: taskId,
            subTaskIds: Array.isArray(task.subTasks) ? task.subTasks.map((id) => id.toString()) : [],
            planned: false,
        };
    }

    async getSubTasks(parentTaskId: string): Promise<ITask[]> {
        return TaskModel.find({ parentTaskId })
            .sort({ createdAt: 1 })
            .exec();
    }

    async getNextExecutableTasks(parentTaskId: string): Promise<ITask[]> {
        const children = await this.getSubTasks(parentTaskId);
        const completed = new Set(
            children
                .filter((task) => task.status === "completed")
                .map((task) => task._id.toString())
        );

        return children.filter((task) => {
            if (task.status !== "pending" && task.status !== "executing") {
                return false;
            }

            const dependencies = (task.dependencyIds || []).map((id) => id.toString());
            return dependencies.every((dependencyId) => completed.has(dependencyId));
        });
    }
}

export default TaskPlanner;
